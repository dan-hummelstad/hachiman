// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"hachiman/server/pkg/voicetoken"
)

// busOf subscribes to a Redis channel and returns a reader of its envelopes.
// The reader fails the test after 2 s; quiet waits briefly and reports whether
// anything came.
func (h *harness) busOf(channel string) (next func() envelope, quiet func() (envelope, bool)) {
	h.t.Helper()
	ctx := context.Background()
	sub := h.rdb.Subscribe(ctx, channel)
	h.t.Cleanup(func() { _ = sub.Close() })
	if _, err := sub.Receive(ctx); err != nil {
		h.t.Fatal(err)
	}
	ch := sub.Channel()
	quiet = func() (envelope, bool) {
		select {
		case m := <-ch:
			var env envelope
			_ = json.Unmarshal([]byte(m.Payload), &env)
			return env, true
		case <-time.After(150 * time.Millisecond):
			return envelope{}, false
		}
	}
	next = func() envelope {
		h.t.Helper()
		select {
		case m := <-ch:
			var env envelope
			_ = json.Unmarshal([]byte(m.Payload), &env)
			return env
		case <-time.After(2 * time.Second):
			h.t.Fatalf("nothing on %s", channel)
			return envelope{}
		}
	}
	return next, quiet
}

// A DM call (§6 "DM calls"): membership instead of guild permissions, state in
// voice_dm:{c}, events on user:{p}, CALL_RING to the others on the first join.
func TestDMCallJoinRingLeave(t *testing.T) {
	h := newHarness(t)
	h.mr.Set(kVoiceRoom("dm1"), "node-a")
	u2, _ := h.busOf("user:u2")
	c := h.dial()
	sid := c.identify()

	join := map[string]any{"guildId": nil, "channelId": "dm1", "selfMute": false, "selfDeaf": false}
	c.send(opVoiceState, join)
	f := c.expect("VOICE_SERVER_UPDATE")
	var vsu struct {
		GuildID   *string
		ChannelID string
		Token     string
	}
	_ = json.Unmarshal(f.D, &vsu)
	if vsu.GuildID != nil || vsu.ChannelID != "dm1" {
		t.Fatalf("bad VOICE_SERVER_UPDATE %s", f.D)
	}
	v, err := voicetoken.NewVerifier(h.g.signer.PublicKeyHex(), "node-a")
	if err != nil {
		t.Fatal(err)
	}
	if cl, err := v.Verify(vsu.Token); err != nil || cl.GuildID != "" || cl.ChannelID != "dm1" || cl.SessionID != sid {
		t.Fatalf("token verify: %v %+v", err, cl)
	}

	if env := u2(); env.T != "VOICE_STATE_UPDATE" || !strings.Contains(string(env.D), `"guildId":null`) || !strings.Contains(string(env.D), `"channelId":"dm1"`) {
		t.Fatalf("u2 got %s %s, want the join", env.T, env.D)
	}
	env := u2()
	var ring struct {
		ChannelID, UserID, At string
		Ringing               []string
	}
	_ = json.Unmarshal(env.D, &ring)
	if env.T != "CALL_RING" || ring.ChannelID != "dm1" || ring.UserID != me || len(ring.Ringing) != 1 || ring.Ringing[0] != "u2" || ring.At == "" {
		t.Fatalf("u2 got %s %s, want CALL_RING", env.T, env.D)
	}
	if got, _ := h.mr.Get(kVoiceUser(me)); got != "dm:dm1" {
		t.Errorf("voice_user = %q", got)
	}
	if h.mr.HGet(kVoiceDM("dm1"), me) == "" {
		t.Error("no state in voice_dm")
	}

	// A mute toggle does not ring again.
	join["selfMute"] = true
	c.send(opVoiceState, join)
	if env := u2(); env.T != "VOICE_STATE_UPDATE" || !strings.Contains(string(env.D), `"selfMute":true`) {
		t.Fatalf("u2 got %s %s, want the mute", env.T, env.D)
	}

	c.send(opVoiceState, map[string]any{"guildId": nil, "channelId": nil})
	if env := u2(); env.T != "VOICE_STATE_UPDATE" || !strings.Contains(string(env.D), `"channelId":null`) {
		t.Fatalf("u2 got %s %s, want the leave", env.T, env.D)
	}
	time.Sleep(50 * time.Millisecond)
	if h.mr.Exists(kVoiceRoom("dm1")) || h.mr.Exists(kVoiceUser(me)) || h.mr.Exists(kVoiceDM("dm1")) {
		t.Error("voice keys survived leave")
	}
}

func TestDMCallRejectsNonParticipantsAndGuildChannels(t *testing.T) {
	h := newHarness(t)
	h.mr.Set(kVoiceRoom("dm-others"), "node-a")
	c := h.dial()
	c.identify()
	for _, ch := range []string{"dm-others", "text", "voice", "missing"} {
		c.send(opVoiceState, map[string]any{"guildId": nil, "channelId": ch})
	}
	c.send(opHeartbeat, nil)
	for {
		f := c.next()
		if f.Op == opHeartbeatAck {
			break
		}
		if f.T == "VOICE_SERVER_UPDATE" || f.T == "VOICE_STATE_UPDATE" {
			t.Fatalf("joined a call it may not join: %s", f.D)
		}
	}
}

// READY carries the live DM call states; a join into a call that has someone
// else in it does not ring.
func TestDMCallReadyStatesAndNoRingWhenOccupied(t *testing.T) {
	h := newHarness(t)
	h.g.load = func(ctx context.Context, userID, onlyGuild string) (*readyData, error) {
		d := fixture()
		d.DMs = []Channel{{ID: "dm1", Type: "dm", Recipients: []User{{ID: "u2", Username: "two"}}}}
		return d, nil
	}
	h.mr.Set(kVoiceRoom("dm1"), "node-a")
	other := VoiceState{ChannelID: ptr("dm1"), UserID: "u2", SessionID: "s2", JoinedAt: iso(time.Now())}
	h.mr.HSet(kVoiceDM("dm1"), "u2", string(mustJSON(other)))
	h.mr.HSet(kSession("s2"), "userId", "u2")
	u2, u2quiet := h.busOf("user:u2")

	c := h.dial()
	c.send(opIdentify, identifyAs(devA))
	var ready struct{ PrivateVoiceStates []VoiceState }
	_ = json.Unmarshal(c.expect("READY").D, &ready)
	if len(ready.PrivateVoiceStates) != 1 || ready.PrivateVoiceStates[0].UserID != "u2" || ready.PrivateVoiceStates[0].GuildID != nil {
		t.Fatalf("privateVoiceStates %+v", ready.PrivateVoiceStates)
	}

	c.send(opVoiceState, map[string]any{"guildId": nil, "channelId": "dm1"})
	for env := u2(); env.T != "VOICE_STATE_UPDATE"; env = u2() {
		if env.T != "PRESENCE_UPDATE" { // u2 is my DM partner
			t.Fatalf("u2 got %s, want the join", env.T)
		}
	}
	c.expect("VOICE_SERVER_UPDATE")
	if env, ok := u2quiet(); ok {
		t.Fatalf("u2 got %s %s after joining an occupied call", env.T, env.D)
	}
}
