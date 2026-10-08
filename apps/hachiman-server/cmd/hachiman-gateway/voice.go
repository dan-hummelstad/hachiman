// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/coturn"
	"hachiman/server/pkg/management"
	"hachiman/server/pkg/permissions"
	"hachiman/server/pkg/voicetoken"
)

type voiceRequest struct {
	GuildID    *string `json:"guildId"` // nil: a DM or group DM call
	ChannelID  *string `json:"channelId"`
	SelfMute   bool    `json:"selfMute"`
	SelfDeaf   bool    `json:"selfDeaf"`
	SelfStream bool    `json:"selfStream"`
	// moved: a VOICE_MOVE by a moderator, not op 4. VOICE_SERVER_UPDATE then says so.
	moved bool
}

var stunOnly = []coturn.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}

// errNotDM: the channel of a DM call is not a dm / group_dm channel.
var errNotDM = errors.New("not a DM channel")

// voiceScope is where a voice state lives (contract §5, §6 "DM calls"): a
// guild (hash voice:{g}, bus guild:{g}) or one DM call (hash voice_dm:{c},
// bus user:{p} of each participant). voice_user:{uid} holds userValue.
type voiceScope struct {
	guildID   string // "" for a DM call
	channelID string // the DM channel of a DM call, else ""
}

func (sc voiceScope) dm() bool { return sc.guildID == "" }

func (sc voiceScope) key() string {
	if sc.dm() {
		return kVoiceDM(sc.channelID)
	}
	return kVoice(sc.guildID)
}

func (sc voiceScope) userValue() string {
	if sc.dm() {
		return "dm:" + sc.channelID
	}
	return sc.guildID
}

func (sc voiceScope) guildPtr() *string {
	if sc.dm() {
		return nil
	}
	return &sc.guildID
}

func parseScope(v string) voiceScope {
	if c, ok := strings.CutPrefix(v, "dm:"); ok {
		return voiceScope{channelID: c}
	}
	return voiceScope{guildID: v}
}

// scopeOf is the scope of a stored state (ChannelID is set on those).
func scopeOf(st VoiceState) voiceScope {
	if st.GuildID != nil {
		return voiceScope{guildID: *st.GuildID}
	}
	if st.ChannelID == nil {
		return voiceScope{}
	}
	return voiceScope{channelID: *st.ChannelID}
}

// onVoice implements contract §6 "Voice join". One voice session per user
// globally: voice_user:{uid} names the scope, the scope hash holds the state.
func (s *session) onVoice(ctx context.Context, req voiceRequest) error {
	if req.ChannelID == nil {
		s.leaveVoice(ctx)
		return nil
	}
	chID, me := *req.ChannelID, s.user.ID
	var (
		sc      voiceScope
		region  string
		members []string // DM call: every participant, me included
		// The server mute and deafen of a guild member (§6 "Voice moderation"); a DM call has none.
		serverMute, serverDeaf bool
	)
	if req.GuildID != nil {
		gs := s.guilds[*req.GuildID]
		if gs == nil {
			return fmt.Errorf("not a member of guild %s", *req.GuildID)
		}
		ch := gs.channels[chID]
		if ch == nil || ch.Type != "voice" {
			return fmt.Errorf("%s is not a voice channel", chID)
		}
		if !permissions.Has(gs.perms(me, ch), permissions.Connect|permissions.ViewChannel) {
			return fmt.Errorf("missing CONNECT on %s", chID)
		}
		sc, region = voiceScope{guildID: gs.id}, gs.region
		serverMute, serverDeaf = gs.myMute, gs.myDeaf
	} else {
		ms, err := s.g.dmMembers(ctx, chID)
		if err != nil {
			return fmt.Errorf("DM call %s: %w", chID, err)
		}
		if !slices.Contains(ms, me) {
			return fmt.Errorf("not a participant of %s", chID)
		}
		sc, members = voiceScope{channelID: chID}, ms
	}

	prev := s.g.currentVoice(ctx, me)
	if prev != nil && scopeOf(*prev) != sc {
		s.g.removeVoice(ctx, *prev)
		prev = nil
	}
	moved := prev == nil || prev.SessionID != s.id || prev.ChannelID == nil || *prev.ChannelID != chID
	// A DM call rings when this join starts it: I was not in it and nobody else is.
	ring := sc.dm() && prev == nil && s.g.roomEmpty(ctx, sc.key(), chID, me)
	joinedAt := iso(time.Now())
	if !moved && prev.JoinedAt != "" {
		joinedAt = prev.JoinedAt // mute/deaf/stream toggle keeps the call timer
	}
	st := VoiceState{GuildID: sc.guildPtr(), ChannelID: &chID, UserID: me, SessionID: s.id, SelfMute: req.SelfMute, SelfDeaf: req.SelfDeaf, Mute: serverMute, Deaf: serverDeaf, SelfStream: req.SelfStream, JoinedAt: joinedAt}
	if _, err := s.g.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, sc.key(), me, string(mustJSON(st)))
		p.Set(ctx, kVoiceUser(me), sc.userValue(), 0)
		return nil
	}); err != nil {
		return err
	}
	s.voice = &st
	s.g.publishVoice(ctx, sc, members, st)
	if ring {
		s.g.ring(ctx, chID, me, members)
	}

	if !moved {
		return nil // mute/deaf/stream toggle: media connection stays as is
	}
	nodeID, endpoint, err := s.g.resolveNode(ctx, chID, sc.guildID, region)
	if err != nil {
		return fmt.Errorf("place media session: %w", err)
	}
	if prev != nil && prev.ChannelID != nil {
		// Same scope, other channel or other device. A same-session move on
		// the same node needs no kick: media replaces by sessionId (4011).
		if prevNode, _ := s.g.rdb.Get(ctx, kVoiceRoom(*prev.ChannelID)).Result(); prev.SessionID != s.id || prevNode != nodeID {
			s.g.kick(ctx, prevNode, prev.SessionID, *prev.ChannelID)
		}
		s.g.releaseRoomIfEmpty(ctx, scopeOf(*prev).key(), *prev.ChannelID)
	}

	now := time.Now()
	claims := voicetoken.Claims{
		SessionID: s.id, UserID: me, DeviceID: s.deviceID, GuildID: sc.guildID, ChannelID: chID, MediaNodeID: nodeID,
		JTI: randomToken(), IssuedAt: now, ExpiresAt: now.Add(voicetoken.DefaultTTL),
		Mute: serverMute || serverDeaf,
	}
	// In the session hash, which outlives a RESUME (VOICE_DISCONNECTED names it).
	s.g.rdb.HSet(ctx, kSession(s.id), "voiceJti", claims.JTI)
	token, err := s.g.signer.Mint(claims)
	if err != nil {
		return err
	}
	ice := stunOnly
	if s.g.turn != nil {
		ice = s.g.turn.Mint(me, now)
	}
	vsu := map[string]any{
		"guildId": sc.guildPtr(), "channelId": chID, "endpoint": endpoint, "token": token,
		"iceServers": ice, "expiresAt": iso(claims.ExpiresAt),
	}
	if req.moved {
		vsu["moved"] = true
	}
	s.dispatch("VOICE_SERVER_UPDATE", vsu)
	return nil
}

// publishVoice sends VOICE_STATE_UPDATE to the scope: the guild, or each
// participant of the DM call. members nil (a DM leave) reads them again; a
// failed read still tells the leaving user.
func (g *Gateway) publishVoice(ctx context.Context, sc voiceScope, members []string, st VoiceState) {
	if !sc.dm() {
		g.publish(ctx, "guild:"+sc.guildID, "VOICE_STATE_UPDATE", st)
		return
	}
	if members == nil {
		members, _ = g.dmMembers(ctx, sc.channelID)
	}
	if !slices.Contains(members, st.UserID) {
		members = append(members, st.UserID)
	}
	for _, uid := range members {
		g.publish(ctx, "user:"+uid, "VOICE_STATE_UPDATE", st)
	}
}

// ring publishes CALL_RING (§6 "DM calls") to every participant but the caller.
func (g *Gateway) ring(ctx context.Context, channelID, caller string, members []string) {
	ringing := slices.DeleteFunc(slices.Clone(members), func(u string) bool { return u == caller })
	if len(ringing) == 0 {
		return
	}
	d := map[string]any{"channelId": channelID, "userId": caller, "ringing": ringing, "at": iso(time.Now())}
	for _, uid := range ringing {
		g.publish(ctx, "user:"+uid, "CALL_RING", d)
	}
}

// roomEmpty reports whether no live session of another user is in channelID.
func (g *Gateway) roomEmpty(ctx context.Context, key, channelID, me string) bool {
	for _, vs := range g.voiceStatesAt(ctx, key) {
		if vs.UserID != me && vs.ChannelID != nil && *vs.ChannelID == channelID {
			return false
		}
	}
	return true
}

// ownsVoice returns the user's current voice state when this session object
// holds that call: the state names this session, and this object owns the
// session (after a RESUME on another node, the old object lives on until its
// grace ends, with the same id).
func (s *session) ownsVoice(ctx context.Context) *VoiceState {
	if s.voice == nil {
		return nil
	}
	cur := s.g.currentVoice(ctx, s.user.ID)
	if cur == nil || cur.SessionID != s.id || cur.ChannelID == nil {
		return nil
	}
	if owner, _ := s.g.rdb.HGet(ctx, kSession(s.id), "owner").Result(); owner != s.owner {
		return nil
	}
	return cur
}

// onVoiceMove handles the internal VOICE_MOVE {guildId, channelId} of Takusen
// on user:{id} (§6 "Voice moderation"): a member with MOVE_MEMBERS moved the
// user (channelId) or disconnected them (null). Only the session in that call acts.
func (s *session) onVoiceMove(raw json.RawMessage) {
	var d struct {
		GuildID   string  `json:"guildId"`
		ChannelID *string `json:"channelId"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	cur := s.ownsVoice(s.ctx)
	if cur == nil || cur.GuildID == nil || *cur.GuildID != d.GuildID {
		return
	}
	if d.ChannelID == nil {
		s.leaveVoice(s.ctx)
		return
	}
	if *cur.ChannelID == *d.ChannelID {
		return
	}
	// A screen share does not move with the user, as for a move by op 4.
	req := voiceRequest{GuildID: &d.GuildID, ChannelID: d.ChannelID, SelfMute: cur.SelfMute, SelfDeaf: cur.SelfDeaf, moved: true}
	if err := s.onVoice(s.ctx, req); err != nil {
		slog.Warn("voice move failed", "session", s.id, "err", err)
	}
}

// applyServerVoice writes a changed server mute or deafen of the user into
// the voice state of this session's call in gs, and tells the media node to
// drop or forward the mic RTP (§6 "Voice moderation").
func (s *session) applyServerVoice(ctx context.Context, gs *guildState) {
	cur := s.ownsVoice(ctx)
	if cur == nil || cur.GuildID == nil || *cur.GuildID != gs.id {
		return
	}
	st := *cur
	st.Mute, st.Deaf = gs.myMute, gs.myDeaf
	if err := s.g.rdb.HSet(ctx, kVoice(gs.id), st.UserID, string(mustJSON(st))).Err(); err != nil {
		slog.Warn("server voice update failed", "session", s.id, "err", err)
		return
	}
	s.voice = &st
	s.g.publishVoice(ctx, voiceScope{guildID: gs.id}, nil, st)
	if node, _ := s.g.rdb.Get(ctx, kVoiceRoom(*st.ChannelID)).Result(); node != "" {
		b, _ := json.Marshal(map[string]any{"op": "mute", "sessionId": s.id, "channelId": *st.ChannelID, "mute": st.Mute || st.Deaf})
		s.g.rdb.Publish(ctx, "media:"+node, b)
	}
}

// leaveVoice drops this session's voice state. Another device's voice
// session for the same user is left alone.
func (s *session) leaveVoice(ctx context.Context) {
	s.voice = nil
	cur := s.g.currentVoice(ctx, s.user.ID)
	if cur == nil || cur.SessionID != s.id {
		return
	}
	s.g.rdb.Del(ctx, kVoiceUser(s.user.ID))
	s.g.removeVoice(ctx, *cur)
}

// restoreVoice re-adopts a voice state this session id held before RESUME.
func (s *session) restoreVoice(ctx context.Context) {
	if cur := s.g.currentVoice(ctx, s.user.ID); cur != nil && cur.SessionID == s.id {
		s.voice = cur
	}
}

// onVoiceDisconnected handles the internal VOICE_DISCONNECTED of hachiman-media
// (§8): the call of that voice token ended without a kick (the client left,
// dropped or timed out). If it is still this session's call, the voice state
// goes now, not after the offline grace. The jti check keeps a late event of
// an earlier call from ending a rejoin of the same channel.
func (s *session) onVoiceDisconnected(raw json.RawMessage) {
	var d struct {
		SessionID string `json:"sessionId"`
		ChannelID string `json:"channelId"`
		JTI       string `json:"jti"`
	}
	if json.Unmarshal(raw, &d) != nil || d.SessionID != s.id || d.JTI == "" {
		return
	}
	if s.voice == nil || s.voice.ChannelID == nil || *s.voice.ChannelID != d.ChannelID {
		return
	}
	// owner: after a RESUME on another node, this object lives on until its
	// grace ends, with the same id; only the owner may act.
	cur, _ := s.g.rdb.HMGet(s.ctx, kSession(s.id), "owner", "voiceJti").Result()
	if len(cur) != 2 || cur[0] != s.owner || cur[1] != d.JTI {
		return
	}
	s.leaveVoice(s.ctx)
}

func (g *Gateway) currentVoice(ctx context.Context, userID string) *VoiceState {
	v, err := g.rdb.Get(ctx, kVoiceUser(userID)).Result()
	if err != nil {
		return nil
	}
	raw, err := g.rdb.HGet(ctx, parseScope(v).key(), userID).Result()
	if err != nil {
		return nil
	}
	var vs VoiceState
	if json.Unmarshal([]byte(raw), &vs) != nil {
		return nil
	}
	return &vs
}

// removeVoice deletes st, announces the leave and kicks the media session.
func (g *Gateway) removeVoice(ctx context.Context, st VoiceState) {
	sc := scopeOf(st)
	g.rdb.HDel(ctx, sc.key(), st.UserID)
	left := st
	left.ChannelID = nil
	g.publishVoice(ctx, sc, nil, left)
	if st.ChannelID != nil {
		node, _ := g.rdb.Get(ctx, kVoiceRoom(*st.ChannelID)).Result()
		g.kick(ctx, node, st.SessionID, *st.ChannelID)
		g.releaseRoomIfEmpty(ctx, sc.key(), *st.ChannelID)
	}
}

// kick names the channel being left so media can ignore it when the same
// session already reconnected into another channel on that node.
func (g *Gateway) kick(ctx context.Context, nodeID, sessionID, channelID string) {
	if nodeID == "" {
		return
	}
	b, _ := json.Marshal(map[string]string{"op": "kick", "sessionId": sessionID, "channelId": channelID})
	g.rdb.Publish(ctx, "media:"+nodeID, b)
}

// releaseRoomIfEmpty drops the sticky node once nobody is left in the channel.
// key is the scope hash (voice:{g} or voice_dm:{c}).
// ponytail: check-then-DEL races a concurrent join; the joiner then gets
// re-placed, possibly on another node than a peer who joined a moment earlier.
func (g *Gateway) releaseRoomIfEmpty(ctx context.Context, key, channelID string) {
	vals, err := g.rdb.HVals(ctx, key).Result()
	if err != nil {
		return
	}
	for _, raw := range vals {
		var vs VoiceState
		if json.Unmarshal([]byte(raw), &vs) == nil && vs.ChannelID != nil && *vs.ChannelID == channelID {
			return
		}
	}
	g.rdb.Del(ctx, kVoiceRoom(channelID))
}

// resolveNode returns the media node hosting channelID, placing it via
// Takusen on first use. voice_room is the only stickiness: Takusen's placement
// just picks the least-loaded node, so SET NX decides races between gateways.
// A DM call has no guild and no home region: any region.
func (g *Gateway) resolveNode(ctx context.Context, channelID, guildID, region string) (nodeID, endpoint string, err error) {
	for attempt := 0; attempt < 2; attempt++ {
		nodeID, err = g.rdb.Get(ctx, kVoiceRoom(channelID)).Result()
		if errors.Is(err, redis.Nil) {
			res, perr := g.placer.PlaceMediaSession(ctx, &management.PlaceMediaSessionRequest{
				ChannelId: channelID, GuildId: guildID, HomeRegion: region,
			})
			if perr != nil {
				return "", "", perr
			}
			won, serr := g.rdb.SetNX(ctx, kVoiceRoom(channelID), res.NodeId, voiceRoomEX).Result()
			if serr != nil {
				return "", "", serr
			}
			if won {
				return res.NodeId, res.SignalingUrl, nil
			}
			continue // another gateway placed it first; use theirs
		}
		if err != nil {
			return "", "", err
		}
		endpoint, err = g.nodeURL(ctx, nodeID)
		if errors.Is(err, errNodeGone) {
			// Sticky entry outlived its node: forget it and place afresh.
			g.rdb.Del(ctx, kVoiceRoom(channelID))
			continue
		}
		return nodeID, endpoint, err
	}
	return "", "", fmt.Errorf("could not settle a media node for %s", channelID)
}
