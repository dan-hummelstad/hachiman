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
)

func TestSanitizeCustomStatus(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name, in string
		want     string // text; "" = clear
		wantExp  string
		err      bool
	}{
		{name: "null clears", in: `null`},
		{name: "plain", in: `{"text":"Reading chapter 6"}`, want: "Reading chapter 6"},
		{name: "trim and strip controls", in: `{"text":"  5am,\u0007 watching\n the VOD‮ \t"}`, want: "5am, watching the VOD"},
		{name: "empty clears", in: `{"text":"   "}`},
		{name: "only controls clears", in: `{"text":"\u0000\u001b"}`},
		{name: "64 runes ok", in: `{"text":"` + strings.Repeat("é", 64) + `"}`, want: strings.Repeat("é", 64)},
		{name: "65 runes rejected", in: `{"text":"` + strings.Repeat("a", 65) + `"}`, err: true},
		{name: "controls do not count", in: `{"text":"` + strings.Repeat("a", 64) + `\u0007"}`, want: strings.Repeat("a", 64)},
		{name: "future expiry", in: `{"text":"brb","expiresAt":"2026-10-07T14:00:00+01:00"}`, want: "brb", wantExp: "2026-10-07T13:00:00Z"},
		{name: "future expiry utc", in: `{"text":"brb","expiresAt":"2026-10-07T14:00:00Z"}`, want: "brb", wantExp: "2026-10-07T14:00:00Z"},
		{name: "past expiry clears", in: `{"text":"brb","expiresAt":"2026-10-07T11:59:59Z"}`},
		{name: "bad expiry", in: `{"text":"brb","expiresAt":"tomorrow"}`, err: true},
		{name: "not an object", in: `"brb"`, err: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cs, err := sanitizeCustomStatus(json.RawMessage(c.in), now)
			if (err != nil) != c.err {
				t.Fatalf("err %v, want err %v", err, c.err)
			}
			if c.want == "" {
				if cs != nil {
					t.Fatalf("got %+v, want clear", cs)
				}
				return
			}
			if cs == nil || cs.Text != c.want {
				t.Fatalf("got %+v, want text %q", cs, c.want)
			}
			if c.wantExp == "" && cs.ExpiresAt != nil || c.wantExp != "" && (cs.ExpiresAt == nil || *cs.ExpiresAt != c.wantExp) {
				t.Fatalf("expiresAt %v, want %q", cs.ExpiresAt, c.wantExp)
			}
		})
	}
}

func TestParseCustomStatusDropsExpired(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	if cs := parseCustomStatus(`{"text":"x","expiresAt":"2026-10-07T12:00:00Z"}`, now); cs != nil {
		t.Errorf("expired status kept: %+v", cs)
	}
	if cs := parseCustomStatus(`{"text":"x","expiresAt":"2026-10-07T12:00:01Z"}`, now); cs == nil {
		t.Error("live status dropped")
	}
	if cs := parseCustomStatus(`{"text":"x","expiresAt":null}`, now); cs == nil {
		t.Error("status without expiry dropped")
	}
	if parseCustomStatus("", now) != nil || parseCustomStatus("{bad", now) != nil {
		t.Error("bad stored value not dropped")
	}
}

// presenceUntil reads PRESENCE_UPDATE frames of me until pred holds.
func (c *client) presenceUntil(pred func(Presence) bool) Presence {
	c.t.Helper()
	for {
		f := c.expect("PRESENCE_UPDATE")
		var p Presence
		_ = json.Unmarshal(f.D, &p)
		if p.UserID == me && pred(p) {
			return p
		}
	}
}

func TestCustomStatusOp3(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	c := h.dial()
	c.identify()

	c.send(opPresenceUpdate, map[string]any{"customStatus": map[string]any{"text": " Reading\u0007 chapter 6 ", "expiresAt": nil}})
	p := c.presenceUntil(func(p Presence) bool { return p.CustomStatus != nil })
	if p.Status != "online" || p.CustomStatus.Text != "Reading chapter 6" || p.CustomStatus.ExpiresAt != nil {
		t.Fatalf("PRESENCE_UPDATE %+v %+v", p, p.CustomStatus)
	}
	if ttl := h.mr.TTL(kCustomStatus(me)); ttl != 0 {
		t.Errorf("status without expiry has TTL %v", ttl)
	}

	// Too long: dropped, no event. The status change after it carries the old text.
	c.send(opPresenceUpdate, map[string]any{"customStatus": map[string]any{"text": strings.Repeat("a", 65)}})
	c.send(opPresenceUpdate, map[string]any{"status": "idle"})
	p = c.presenceUntil(func(p Presence) bool { return p.Status == "idle" })
	if p.CustomStatus == nil || p.CustomStatus.Text != "Reading chapter 6" {
		t.Fatalf("idle PRESENCE_UPDATE lost the custom status: %+v", p.CustomStatus)
	}

	// READY of another session shows it in the guild presences.
	c2 := h.dial()
	c2.send(opIdentify, identifyAs(devB))
	var r struct{ Guilds []GuildFull }
	_ = json.Unmarshal(c2.expect("READY").D, &r)
	if len(r.Guilds) != 1 || len(r.Guilds[0].Presences) != 1 || r.Guilds[0].Presences[0].CustomStatus == nil ||
		r.Guilds[0].Presences[0].CustomStatus.Text != "Reading chapter 6" {
		t.Fatalf("READY presences %+v", r.Guilds)
	}

	// An expiry gives the key a TTL; an expired value is dropped on read.
	exp := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	c.send(opPresenceUpdate, map[string]any{"customStatus": map[string]any{"text": "brb", "expiresAt": exp}})
	p = c.presenceUntil(func(p Presence) bool { return p.CustomStatus != nil && p.CustomStatus.Text == "brb" })
	if p.CustomStatus.ExpiresAt == nil || *p.CustomStatus.ExpiresAt != exp {
		t.Errorf("expiresAt %v, want %s", p.CustomStatus.ExpiresAt, exp)
	}
	if ttl := h.mr.TTL(kCustomStatus(me)); ttl <= 59*time.Minute || ttl > time.Hour {
		t.Errorf("TTL %v, want about 1h", ttl)
	}
	h.mr.Set(kCustomStatus(me), `{"text":"old","expiresAt":"2020-01-01T00:00:00Z"}`)
	if ps := h.g.presences(ctx, []string{me}); len(ps) != 1 || ps[0].CustomStatus != nil {
		t.Errorf("expired status read back: %+v", ps)
	}

	// null clears.
	c.send(opPresenceUpdate, map[string]any{"customStatus": "x"}) // not an object: dropped
	c.send(opPresenceUpdate, map[string]any{"customStatus": nil})
	c.presenceUntil(func(p Presence) bool { return p.CustomStatus == nil && p.Status == "idle" })
	if h.mr.Exists(kCustomStatus(me)) {
		t.Error("custom status key survived a clear")
	}
}

// joinedAt is set on join, kept across a mute toggle, and reset on a move.
func TestVoiceJoinedAt(t *testing.T) {
	h := newHarness(t)
	h.g.load = func(ctx context.Context, userID, onlyGuild string) (*readyData, error) {
		d := fixture()
		d.Guilds[0].Channels = append(d.Guilds[0].Channels, Channel{ID: "voice2", GuildID: ptr(gid), Type: "voice", Name: ptr("Den")})
		return d, nil
	}
	h.mr.Set(kVoiceRoom("voice"), "node-a")
	h.mr.Set(kVoiceRoom("voice2"), "node-a")
	c := h.dial()
	c.identify()

	state := func(want func(VoiceState) bool) VoiceState {
		t.Helper()
		for {
			f := c.next()
			if f.T != "VOICE_STATE_UPDATE" {
				continue
			}
			var vs VoiceState
			_ = json.Unmarshal(f.D, &vs)
			if want(vs) {
				return vs
			}
		}
	}
	join := map[string]any{"guildId": gid, "channelId": "voice", "selfMute": false}
	c.send(opVoiceState, join)
	vs := state(func(vs VoiceState) bool { return vs.ChannelID != nil })
	joined, err := time.Parse(time.RFC3339Nano, vs.JoinedAt)
	if err != nil || time.Since(joined) > 5*time.Second {
		t.Fatalf("joinedAt %q on join (%v)", vs.JoinedAt, err)
	}

	time.Sleep(5 * time.Millisecond)
	join["selfMute"] = true
	c.send(opVoiceState, join)
	vs = state(func(vs VoiceState) bool { return vs.SelfMute })
	if vs.JoinedAt != iso(joined) {
		t.Errorf("mute toggle changed joinedAt %s to %q", iso(joined), vs.JoinedAt)
	}
	var stored VoiceState
	_ = json.Unmarshal([]byte(h.mr.HGet(kVoice(gid), me)), &stored)
	if stored.JoinedAt != iso(joined) {
		t.Errorf("stored joinedAt %q", stored.JoinedAt)
	}

	time.Sleep(5 * time.Millisecond)
	join["channelId"] = "voice2"
	c.send(opVoiceState, join)
	vs = state(func(vs VoiceState) bool { return vs.ChannelID != nil && *vs.ChannelID == "voice2" })
	if moved, err := time.Parse(time.RFC3339Nano, vs.JoinedAt); err != nil || !moved.After(joined) {
		t.Errorf("move kept joinedAt %q, want reset", vs.JoinedAt)
	}
}
