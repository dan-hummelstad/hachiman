// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis keys, contract §5.
const (
	sessionTTL  = 90 * time.Second // also the resume buffer's LTRIM bound of 500 lives in appendScript
	voiceRoomEX = 24 * time.Hour
)

func kSession(id string) string       { return "session:" + id }
func kEvents(id string) string        { return "events:" + id }
func kPresence(uid string) string     { return "presence:" + uid }
func kVoice(gid string) string        { return "voice:" + gid }
func kVoiceUser(uid string) string    { return "voice_user:" + uid }
func kVoiceRoom(cid string) string    { return "voice_room:" + cid }
func kUserSessions(uid string) string { return "user_sessions:" + uid } // not in contract §5; see session.end

// appendScript assigns the next seq and records the frame atomically, but
// only while this process still owns the session. `owner` flips when another
// connection RESUMEs (on any node), which is how a zombie socket or a
// detached session learns it has been superseded: the script returns nil.
var appendScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return false end
local s = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local f = '{"op":0,"s":' .. s .. ',"t":' .. ARGV[2] .. ',"d":' .. ARGV[3] .. '}'
redis.call('LPUSH', KEYS[2], f)
redis.call('LTRIM', KEYS[2], 0, 499)
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
return f
`)

// takeoverScript claims a session for a RESUMEing connection and returns
// {seq, frames newest-first} in the same atomic step, so no frame can be
// appended by the previous owner after we read the buffer.
var takeoverScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[1] then return false end
redis.call('HSET', KEYS[1], 'owner', ARGV[2])
return {redis.call('HGET', KEYS[1], 'seq'), redis.call('LRANGE', KEYS[2], 0, -1)}
`)

type envelope struct {
	T         string          `json:"t"`
	D         json.RawMessage `json:"d"`
	ChannelID string          `json:"channelId,omitempty"`
}

type busEvent struct {
	scope, id string // "guild"|"user", id
	env       envelope
}

// runBus holds the one PSUBSCRIBE per process and fans envelopes out to the
// local sessions indexed under that guild / user.
// ponytail: events published while go-redis is reconnecting are lost; clients
// only notice on their next RESUME/READY.
func (g *Gateway) runBus(ctx context.Context) {
	ps := g.rdb.PSubscribe(ctx, "guild:*", "user:*")
	defer ps.Close()
	if _, err := ps.Receive(ctx); err != nil {
		slog.Error("psubscribe failed", "err", err)
	}
	close(g.busReady)
	for m := range ps.Channel() {
		g.route(m.Channel, m.Payload)
	}
}

func (g *Gateway) route(channel, payload string) {
	scope, id, ok := strings.Cut(channel, ":")
	if !ok {
		return
	}
	var env envelope
	if err := json.Unmarshal([]byte(payload), &env); err != nil || env.T == "" {
		slog.Warn("bad envelope", "channel", channel, "err", err)
		return
	}
	g.mu.RLock()
	idx := g.byGuild
	if scope == "user" {
		idx = g.byUser
	}
	targets := make([]*session, 0, len(idx[id]))
	for s := range idx[id] {
		targets = append(targets, s)
	}
	g.mu.RUnlock()
	for _, s := range targets {
		s.post(busEvent{scope, id, env})
	}
}

func (g *Gateway) publish(ctx context.Context, channel, t string, d any) {
	b, err := json.Marshal(envelope{T: t, D: mustJSON(d)})
	if err == nil {
		err = g.rdb.Publish(ctx, channel, b).Err()
	}
	if err != nil {
		slog.Warn("publish failed", "channel", channel, "t", t, "err", err)
	}
}

// Session index. A session is subscribed to user:{its user} and guild:{g}
// for every guild it is a member of.

func (g *Gateway) addSession(s *session) {
	g.mu.Lock()
	old := g.sessions[s.id]
	g.sessions[s.id] = s
	add(g.byUser, s.user.ID, s)
	for gid := range s.guilds {
		add(g.byGuild, gid, s)
	}
	g.mu.Unlock()
	if old != nil {
		old.stop(false) // same-node RESUME: the takeover already happened in Redis
	}
}

func (g *Gateway) removeSession(s *session) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.sessions[s.id] == s {
		delete(g.sessions, s.id)
	}
	del(g.byUser, s.user.ID, s)
	for gid := range s.guilds {
		del(g.byGuild, gid, s)
	}
}

func (g *Gateway) subscribe(s *session, gid string) {
	g.mu.Lock()
	add(g.byGuild, gid, s)
	g.mu.Unlock()
}

func (g *Gateway) unsubscribe(s *session, gid string) {
	g.mu.Lock()
	del(g.byGuild, gid, s)
	g.mu.Unlock()
}

func add(idx map[string]map[*session]struct{}, k string, s *session) {
	if idx[k] == nil {
		idx[k] = map[*session]struct{}{}
	}
	idx[k][s] = struct{}{}
}

func del(idx map[string]map[*session]struct{}, k string, s *session) {
	delete(idx[k], s)
	if len(idx[k]) == 0 {
		delete(idx, k)
	}
}

func mustJSON(v any) json.RawMessage {
	if raw, ok := v.(json.RawMessage); ok {
		return raw
	}
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only our own structs reach here
	}
	return b
}
