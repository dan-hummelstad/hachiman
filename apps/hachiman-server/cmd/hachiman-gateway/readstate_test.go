// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"hachiman/server/pkg/permissions"
)

// readStateFixture adds a pages channel and a DM to the fixture, and a read
// state for each read-state channel, the hidden "secret" included.
func readStateFixture() *readyData {
	d := fixture()
	d.Guilds[0].Channels = append(d.Guilds[0].Channels,
		Channel{ID: "pages", GuildID: ptr(gid), Type: "pages", Name: ptr("wiki"), PermissionOverwrites: []permissions.Overwrite{}})
	d.DMs = []Channel{{ID: "dm1", Type: "dm", PermissionOverwrites: []permissions.Overwrite{}, Recipients: []User{{ID: "u2", Username: "u2"}}}}
	ids, guildOf := readStateChannels(d)
	for _, id := range ids {
		d.ReadStates = append(d.ReadStates, ReadState{ChannelID: id, LastReadMessageID: ptr("m-" + id), UnreadCount: 2, LastMessageID: ptr("n-" + id), LastMessageAt: ptr("2026-10-09T10:00:00Z"), guildID: guildOf[id]})
	}
	return d
}

func TestReadStateChannelsTakesTextPagesAndDMs(t *testing.T) {
	ids, guildOf := readStateChannels(readStateFixture())
	if got := strings.Join(ids, ","); got != "text,secret,pages,dm1" {
		t.Errorf("read-state channels %s, want text,secret,pages,dm1 (no voice)", got)
	}
	if g := guildOf["text"]; g == nil || *g != gid {
		t.Errorf("guild of text %v, want %s", g, gid)
	}
	if g, ok := guildOf["dm1"]; !ok || g != nil {
		t.Errorf("guild of dm1 %v (%v), want nil", g, ok)
	}
}

func TestReadyReadStatesHideInvisibleChannels(t *testing.T) {
	h := newHarness(t)
	h.g.load = func(ctx context.Context, userID, onlyGuild string) (*readyData, error) {
		return readStateFixture(), nil
	}
	c := h.dial()
	c.send(opIdentify, identifyAs(devA))
	f := c.expect("READY")
	var r struct{ ReadStates []map[string]any }
	if err := json.Unmarshal(f.D, &r); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, rs := range r.ReadStates {
		ids = append(ids, rs["channelId"].(string))
	}
	if got := strings.Join(ids, ","); got != "text,pages,dm1" {
		t.Errorf("READY readStates %s, want text,pages,dm1 (no read state for a channel without VIEW_CHANNEL)", got)
	}
	want := map[string]any{"channelId": "text", "lastReadMessageId": "m-text", "unreadCount": float64(2), "lastMessageId": "n-text", "lastMessageAt": "2026-10-09T10:00:00Z"}
	for k, v := range want {
		if r.ReadStates[0][k] != v {
			t.Errorf("readStates[0].%s = %v, want %v", k, r.ReadStates[0][k], v)
		}
	}
	if len(r.ReadStates[0]) != len(want) {
		t.Errorf("readStates[0] has fields %v, want only %v", r.ReadStates[0], want)
	}
}

func TestReadyReadStatesEmptyIsArray(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.send(opIdentify, identifyAs(devA))
	f := c.expect("READY")
	if !strings.Contains(string(f.D), `"readStates":[]`) {
		t.Errorf("READY without read states: %s, want readStates: []", f.D)
	}
}

func TestReadStateUpdateGoesToUserSessions(t *testing.T) {
	h := newHarness(t)
	a, b := h.dial(), h.dial()
	a.identifyDevice(devA)
	b.identifyDevice(devB)
	h.pub("user:"+me, "READ_STATE_UPDATE", map[string]string{"channelId": "text", "lastReadMessageId": "m9"}, "")
	for _, c := range []*client{a, b} {
		f := c.expect("READ_STATE_UPDATE")
		var d map[string]string
		_ = json.Unmarshal(f.D, &d)
		if d["channelId"] != "text" || d["lastReadMessageId"] != "m9" {
			t.Errorf("READ_STATE_UPDATE %s", f.D)
		}
	}
}
