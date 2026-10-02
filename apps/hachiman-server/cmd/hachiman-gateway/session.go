// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/permissions"
)

type detach struct {
	c   *conn
	bye bool // clean client close: end now instead of after the resume grace
}

// guildState is the permission view one session needs to filter events.
// It holds every channel of the guild, visible or not.
type guildState struct {
	id, ownerID, region string
	roles               map[string]int64 // role id → permissions (incl. @everyone = guild id)
	myRoles             []string
	channels            map[string]*Channel
}

func (gs *guildState) perms(userID string, ch *Channel) int64 {
	return permissions.ComputeChannel(gs.id, gs.ownerID, userID, gs.myRoles, gs.roles, ch.PermissionOverwrites)
}

func (gs *guildState) visible(userID string) map[string]bool {
	out := map[string]bool{}
	for id, ch := range gs.channels {
		if gs.perms(userID, ch) != 0 {
			out[id] = true
		}
	}
	return out
}

func (gs *guildState) canView(userID, channelID string) bool {
	ch := gs.channels[channelID]
	return ch != nil && gs.perms(userID, ch) != 0
}

// session state is owned by its run goroutine; other goroutines only post().
type session struct {
	g     *Gateway
	id    string
	owner string // this process's claim on session:{id}; see appendScript
	user  User
	ctx   context.Context

	in       chan any
	dead     chan struct{}
	stopOnce sync.Once
	killed   bool // stop reason: true = tear the session down, false = superseded

	conn       *conn // nil while detached, awaiting RESUME
	status     string
	guilds     map[string]*guildState
	dmPartners map[string]bool
	voice      *VoiceState
}

func (g *Gateway) newSession(id string, user User, c *conn) *session {
	return &session{
		g: g, id: id, owner: randomToken(), user: user, ctx: context.Background(),
		in: make(chan any, 256), dead: make(chan struct{}), conn: c,
		guilds: map[string]*guildState{}, dmPartners: map[string]bool{},
	}
}

// post never blocks the bus router. A session that can't keep up is killed
// outright (not just disconnected) so its resume fails and the client
// re-IDENTIFYs instead of silently missing events.
func (s *session) post(it any) {
	select {
	case s.in <- it:
	default:
		s.stop(true)
	}
}

func (s *session) stop(kill bool) {
	s.stopOnce.Do(func() {
		s.killed = kill
		close(s.dead)
	})
}

func (s *session) run(first func()) {
	defer s.g.removeSession(s)
	first()
	var grace <-chan time.Time
	for {
		select {
		case it := <-s.in:
			switch it := it.(type) {
			case busEvent:
				s.onEvent(it)
			case inFrame:
				s.onOp(it)
			case detach:
				if it.c != s.conn {
					break
				}
				s.conn = nil
				if it.bye {
					s.end()
					return
				}
				grace = time.After(s.g.offlineGrace)
			}
		case <-grace:
			s.end()
			return
		case <-s.dead:
			if s.conn != nil {
				s.conn.close(closeUnknownError, "session closed")
			}
			if s.killed {
				s.end()
			}
			return
		}
	}
}

// end tears down a session nobody resumed (or that was killed): voice,
// presence, and the resume keys so a late RESUME gets INVALID_SESSION.
func (s *session) end() {
	ctx := s.ctx
	if owner, _ := s.g.rdb.HGet(ctx, kSession(s.id), "owner").Result(); owner != s.owner && owner != "" {
		return // resumed elsewhere; the new owner carries on
	}
	s.leaveVoice(ctx)
	s.g.rdb.Del(ctx, kSession(s.id), kEvents(s.id))
	// user_sessions lets a second device keep the user online; members whose
	// session key expired (crashed node) are pruned here.
	uk := kUserSessions(s.user.ID)
	s.g.rdb.SRem(ctx, uk, s.id)
	others, _ := s.g.rdb.SMembers(ctx, uk).Result()
	live := 0
	for _, o := range others {
		if n, _ := s.g.rdb.Exists(ctx, kSession(o)).Result(); n > 0 {
			live++
		} else {
			s.g.rdb.SRem(ctx, uk, o)
		}
	}
	if live == 0 {
		s.g.rdb.Del(ctx, kPresence(s.user.ID))
		s.status = "offline"
		s.publishPresence()
	}
}

// dispatch appends a frame to the resume buffer and sends it if attached.
func (s *session) dispatch(t string, d any) {
	tj, _ := json.Marshal(t)
	f, err := appendScript.Run(s.ctx, s.g.rdb, []string{kSession(s.id), kEvents(s.id)}, s.owner, tj, []byte(mustJSON(d))).Text()
	if errors.Is(err, redis.Nil) {
		s.stop(false) // superseded by a RESUME elsewhere (or keys expired)
		return
	}
	if err != nil {
		slog.Warn("dispatch append failed", "session", s.id, "t", t, "err", err)
		return
	}
	if s.conn != nil {
		s.conn.send([]byte(f))
	}
}

func (s *session) seed(data *readyData) {
	for _, gf := range data.Guilds {
		s.addGuild(gf)
	}
	for _, ch := range data.DMs {
		s.addDM(ch)
	}
}

func (s *session) addGuild(gf *GuildFull) {
	gs := &guildState{id: gf.ID, ownerID: gf.OwnerID, roles: map[string]int64{}, channels: map[string]*Channel{}}
	if gf.Region != nil {
		gs.region = *gf.Region
	}
	for _, r := range gf.Roles {
		gs.roles[r.ID] = r.Permissions
	}
	for i := range gf.Channels {
		gs.channels[gf.Channels[i].ID] = &gf.Channels[i]
	}
	for _, m := range gf.Members {
		if m.User.ID == s.user.ID {
			gs.myRoles = m.Roles
		}
	}
	s.guilds[gf.ID] = gs
}

func (s *session) addDM(ch Channel) {
	for _, u := range ch.Recipients {
		s.dmPartners[u.ID] = true
	}
}

// clientGuilds turns loaded guilds into the client's view: visible channels
// only, plus live voice states and online presences from Redis.
func (s *session) clientGuilds(ctx context.Context, gfs []*GuildFull) []GuildFull {
	out := make([]GuildFull, 0, len(gfs))
	for _, gf := range gfs {
		v := *gf
		gs := s.guilds[gf.ID]
		v.Channels = []Channel{}
		for _, ch := range gf.Channels {
			if gs != nil && gs.canView(s.user.ID, ch.ID) {
				v.Channels = append(v.Channels, ch)
			}
		}
		ids := make([]string, 0, len(gf.Members))
		for _, m := range gf.Members {
			ids = append(ids, m.User.ID)
		}
		v.Roles, v.Members = nonNil(gf.Roles), nonNil(gf.Members)
		v.Presences = s.g.presences(ctx, ids)
		v.VoiceStates = s.g.voiceStates(ctx, gf.ID)
		out = append(out, v)
	}
	return out
}

func (g *Gateway) presences(ctx context.Context, userIDs []string) []Presence {
	out := []Presence{}
	if len(userIDs) == 0 {
		return out
	}
	ks := make([]string, len(userIDs))
	for i, id := range userIDs {
		ks[i] = kPresence(id)
	}
	vals, err := g.rdb.MGet(ctx, ks...).Result()
	if err != nil {
		slog.Warn("presence read failed", "err", err)
	}
	for i, v := range vals {
		if st, ok := v.(string); ok && st != "offline" {
			out = append(out, Presence{UserID: userIDs[i], Status: st})
		}
	}
	return out
}

// voiceStates reads voice:{g}, dropping entries whose gateway session is gone.
func (g *Gateway) voiceStates(ctx context.Context, guildID string) []VoiceState {
	out := []VoiceState{}
	all, err := g.rdb.HGetAll(ctx, kVoice(guildID)).Result()
	if err != nil {
		return out
	}
	for _, raw := range all {
		var vs VoiceState
		if json.Unmarshal([]byte(raw), &vs) != nil {
			continue
		}
		if n, _ := g.rdb.Exists(ctx, kSession(vs.SessionID)).Result(); n > 0 {
			out = append(out, vs)
		}
	}
	return out
}

// restorePresence adopts the user's current status (another device, or a
// previous session) or defaults to online. Returns true if it changed.
func (s *session) restorePresence(ctx context.Context) bool {
	cur, _ := s.g.rdb.Get(ctx, kPresence(s.user.ID)).Result()
	s.status = cur
	if cur == "" {
		s.status = "online"
	}
	s.g.rdb.Set(ctx, kPresence(s.user.ID), s.status, sessionTTL)
	return cur == ""
}

func (s *session) publishPresence() {
	d := Presence{UserID: s.user.ID, Status: s.status}
	for gid := range s.guilds {
		s.g.publish(s.ctx, "guild:"+gid, "PRESENCE_UPDATE", d)
	}
	for uid := range s.dmPartners {
		s.g.publish(s.ctx, "user:"+uid, "PRESENCE_UPDATE", d)
	}
}

func (s *session) onOp(f inFrame) {
	switch f.Op {
	case opPresenceUpdate:
		var p struct{ Status string }
		if json.Unmarshal(f.D, &p) != nil || !slices.Contains([]string{"online", "idle", "dnd", "offline"}, p.Status) || p.Status == s.status {
			return
		}
		s.status = p.Status
		s.g.rdb.Set(s.ctx, kPresence(s.user.ID), s.status, sessionTTL)
		s.publishPresence()
	case opVoiceState:
		var p voiceRequest
		if json.Unmarshal(f.D, &p) != nil {
			return
		}
		if err := s.onVoice(s.ctx, p); err != nil {
			slog.Warn("voice state update failed", "session", s.id, "err", err)
		}
	}
}

// onEvent applies a bus envelope to the session's permission view, then
// forwards what this user may see. Contract §5 VIEW_CHANNEL filtering.
func (s *session) onEvent(ev busEvent) {
	e, me := ev.env, s.user.ID
	if ev.scope == "user" {
		s.onUserEvent(e)
		return
	}
	gs := s.guilds[ev.id]
	if gs == nil {
		return // unsubscribed while the event was in flight
	}
	switch e.T {
	case "CHANNEL_CREATE", "CHANNEL_UPDATE":
		var ch Channel
		if json.Unmarshal(e.D, &ch) != nil {
			return
		}
		was := gs.canView(me, ch.ID)
		gs.channels[ch.ID] = &ch
		now := gs.canView(me, ch.ID)
		switch {
		case now && !was:
			s.dispatch("CHANNEL_CREATE", e.D)
		case now:
			s.dispatch(e.T, e.D)
		case was:
			s.dispatch("CHANNEL_DELETE", e.D)
		}
	case "CHANNEL_DELETE":
		var ch Channel
		if json.Unmarshal(e.D, &ch) != nil {
			return
		}
		was := gs.canView(me, ch.ID)
		delete(gs.channels, ch.ID)
		if was {
			s.dispatch(e.T, e.D)
		}
	case "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE":
		var p struct{ Role Role }
		if json.Unmarshal(e.D, &p) != nil {
			return
		}
		s.dispatch(e.T, e.D)
		s.withVisibilityDiff(gs, func() { gs.roles[p.Role.ID] = p.Role.Permissions })
	case "GUILD_ROLE_DELETE":
		var p struct{ RoleID string }
		if json.Unmarshal(e.D, &p) != nil {
			return
		}
		s.dispatch(e.T, e.D)
		s.withVisibilityDiff(gs, func() {
			delete(gs.roles, p.RoleID)
			gs.myRoles = slices.DeleteFunc(slices.Clone(gs.myRoles), func(r string) bool { return r == p.RoleID })
		})
	case "GUILD_MEMBER_UPDATE":
		var m Member
		if json.Unmarshal(e.D, &m) != nil {
			return
		}
		s.dispatch(e.T, e.D)
		if m.User.ID == me {
			s.withVisibilityDiff(gs, func() { gs.myRoles = m.Roles })
		}
	case "GUILD_UPDATE":
		var gd Guild
		if json.Unmarshal(e.D, &gd) != nil {
			return
		}
		s.dispatch(e.T, e.D)
		s.withVisibilityDiff(gs, func() {
			if gd.OwnerID != "" {
				gs.ownerID = gd.OwnerID
			}
			if gd.Region != nil {
				gs.region = *gd.Region
			}
		})
	case "GUILD_MEMBER_REMOVE":
		var p struct{ User User }
		if json.Unmarshal(e.D, &p) != nil {
			return
		}
		s.dispatch(e.T, e.D)
		if p.User.ID == me {
			s.dropGuild(gs.id)
		}
	case "GUILD_DELETE":
		s.dispatch(e.T, e.D)
		s.dropGuild(gs.id)
	default:
		if e.ChannelID != "" && !gs.canView(me, e.ChannelID) {
			return
		}
		s.dispatch(e.T, e.D)
	}
}

func (s *session) onUserEvent(e envelope) {
	switch e.T {
	case "GUILD_CREATE":
		var gf GuildFull
		if json.Unmarshal(e.D, &gf) != nil || gf.ID == "" {
			return
		}
		// Reload from Postgres: Takusen's payload holds only the channels
		// visible right now, and we need hidden ones to track permission
		// changes. Fall back to the payload if the read fails.
		full := &gf
		if data, err := s.g.load(s.ctx, s.user.ID, gf.ID); err == nil && len(data.Guilds) == 1 {
			full = data.Guilds[0]
		} else if err != nil {
			slog.Warn("guild reload failed; using event payload", "guild", gf.ID, "err", err)
		}
		s.addGuild(full)
		s.g.subscribe(s, gf.ID)
		s.dispatch("GUILD_CREATE", s.clientGuilds(s.ctx, []*GuildFull{full})[0])
	case "GUILD_DELETE":
		var p struct{ ID string }
		if json.Unmarshal(e.D, &p) != nil || s.guilds[p.ID] == nil {
			return // already handled via guild:{id}
		}
		s.dispatch(e.T, e.D)
		s.dropGuild(p.ID)
	case "CHANNEL_CREATE":
		var ch Channel
		if json.Unmarshal(e.D, &ch) == nil {
			s.addDM(ch)
		}
		s.dispatch(e.T, e.D)
	default:
		s.dispatch(e.T, e.D)
	}
}

// withVisibilityDiff applies a permission-state mutation and tells the client
// about channels it gained or lost as a consequence.
func (s *session) withVisibilityDiff(gs *guildState, mutate func()) {
	before := gs.visible(s.user.ID)
	mutate()
	after := gs.visible(s.user.ID)
	for id := range after {
		if !before[id] {
			s.dispatch("CHANNEL_CREATE", gs.channels[id])
		}
	}
	for id := range before {
		if !after[id] {
			s.dispatch("CHANNEL_DELETE", gs.channels[id])
		}
	}
}

func (s *session) dropGuild(gid string) {
	if s.voice != nil && s.voice.GuildID == gid {
		s.leaveVoice(s.ctx)
	}
	delete(s.guilds, gid)
	s.g.unsubscribe(s, gid)
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
