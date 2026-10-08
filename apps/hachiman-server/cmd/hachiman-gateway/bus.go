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
	sessionTTL  = 90 * time.Second // TTL of the per-session keys (see touch); the 500-frame resume bound is in appendScript
	voiceRoomEX = 24 * time.Hour
)

func kSession(id string) string       { return "session:" + id }
func kEvents(id string) string        { return "events:" + id }
func kPresence(uid string) string     { return "presence:" + uid }
func kVoice(gid string) string        { return "voice:" + gid }
func kVoiceUser(uid string) string    { return "voice_user:" + uid }
func kVoiceRoom(cid string) string    { return "voice_room:" + cid }
func kVoiceDM(cid string) string      { return "voice_dm:" + cid }      // the states of one DM call
func kUserSessions(uid string) string { return "user_sessions:" + uid } // see session.end
func kDeviceOnline(did string) string { return "device_online:" + did } // read by the Takusen batch scheduler (§12.7.5)

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
// appended by the previous owner after we read the buffer. A user or
// device mismatch returns nil (INVALID_SESSION).
var takeoverScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[1] then return false end
if redis.call('HGET', KEYS[1], 'deviceId') ~= ARGV[2] then return false end
redis.call('HSET', KEYS[1], 'owner', ARGV[3])
return {redis.call('HGET', KEYS[1], 'seq'), redis.call('LRANGE', KEYS[2], 0, -1)}
`)

// claimDeviceScript sets device_online (KEYS[2]) to the session id only while
// session:{id} (KEYS[1]) exists, so a heartbeat that races session.end does
// not bring the key back for an ended session.
var claimDeviceScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return 1
`)

// delIfEqualScript deletes KEYS[1] only while it still holds ARGV[1]. A
// session that ends must not delete device_online of a newer session.
var delIfEqualScript = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`)

type envelope struct {
	T         string          `json:"t"`
	D         json.RawMessage `json:"d"`
	ChannelID string          `json:"channelId,omitempty"`
}

type busEvent struct {
	scope, id string // "guild"|"user"|"device", id
	env       envelope
}

// runBus holds the one PSUBSCRIBE per process and fans envelopes out to the
// local sessions indexed under that guild / user / device.
// ponytail: events published while go-redis is reconnecting are lost; clients
// only notice on their next RESUME/READY.
func (g *Gateway) runBus(ctx context.Context) {
	ps := g.rdb.PSubscribe(ctx, "guild:*", "user:*", "device:*")
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
	var idx map[string]map[*session]struct{}
	switch scope {
	case "guild":
		idx = g.byGuild
	case "user":
		idx = g.byUser
	case "device":
		idx = g.byDevice
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
	g.publishEnvelope(ctx, channel, envelope{T: t, D: mustJSON(d)})
}

func (g *Gateway) publishEnvelope(ctx context.Context, channel string, env envelope) {
	b, err := json.Marshal(env)
	if err == nil {
		err = g.rdb.Publish(ctx, channel, b).Err()
	}
	if err != nil {
		slog.Warn("publish failed", "channel", channel, "t", env.T, "err", err)
	}
}

// Session index. A session is subscribed to user:{its user},
// device:{its device} and guild:{g} for every guild it is a member of.

func (g *Gateway) addSession(s *session) {
	g.mu.Lock()
	old := g.sessions[s.id]
	g.sessions[s.id] = s
	add(g.byUser, s.user.ID, s)
	add(g.byDevice, s.deviceID, s)
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
	del(g.byDevice, s.deviceID, s)
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
