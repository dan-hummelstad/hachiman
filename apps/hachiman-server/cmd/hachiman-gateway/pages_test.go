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

	"github.com/gorilla/websocket"

	"hachiman/server/pkg/permissions"
)

// pagesHarness adds a visible pages channel "pages" and a hidden one
// "hpages" to the fixture.
func pagesHarness(t *testing.T) *harness {
	h := newHarness(t)
	h.g.load = func(ctx context.Context, userID, onlyGuild string) (*readyData, error) {
		d := fixture()
		hidden := []permissions.Overwrite{{ID: gid, Type: "role", Deny: permissions.ViewChannel}}
		d.Guilds[0].Channels = append(d.Guilds[0].Channels,
			Channel{ID: "pages", GuildID: ptr(gid), Type: "pages", Name: ptr("wiki"), PermissionOverwrites: []permissions.Overwrite{}},
			Channel{ID: "hpages", GuildID: ptr(gid), Type: "pages", Name: ptr("mod-wiki"), PermissionOverwrites: hidden},
		)
		return d, nil
	}
	return h
}

func awareness(channelID, pageID, env string) map[string]string {
	return map[string]string{"channelId": channelID, "pageId": pageID, "envelope": env}
}

func TestDocAwarenessRelayedEphemeral(t *testing.T) {
	h := pagesHarness(t)
	a, b := h.dial(), h.dial()
	sidA := a.identifyDevice(devA)
	sidB := b.identifyDevice(devB)

	a.send(opDocAwareness, awareness("pages", "p1", "ZW52"))
	for _, c := range []*client{a, b} { // the sender gets it too
		f := c.expect("DOC_AWARENESS")
		if f.S != 0 {
			t.Errorf("DOC_AWARENESS has s=%d, want none", f.S)
		}
		var d map[string]string
		_ = json.Unmarshal(f.D, &d)
		want := map[string]string{"channelId": "pages", "guildId": gid, "pageId": "p1", "userId": me, "deviceId": devA, "envelope": "ZW52"}
		for k, v := range want {
			if d[k] != v {
				t.Errorf("DOC_AWARENESS %s = %q, want %q", k, d[k], v)
			}
		}
	}

	h.pub("guild:"+gid, "DOC_UPDATE", map[string]any{"pageId": "p1", "seq": 3, "channelId": "pages", "guildId": gid}, "pages")
	if f := b.expect("DOC_UPDATE"); f.S != 0 {
		t.Errorf("DOC_UPDATE has s=%d, want none", f.S)
	}
	for _, sid := range []string{sidA, sidB} {
		if buf := strings.Join(lrange(h, kEvents(sid)), ""); strings.Contains(buf, "DOC_") {
			t.Errorf("events:%s holds an ephemeral event: %s", sid, buf)
		}
	}

	// DOC_UPDATE keeps the VIEW_CHANNEL filter.
	h.pub("guild:"+gid, "DOC_UPDATE", map[string]any{"pageId": "hidden"}, "hpages")
	h.pub("guild:"+gid, "DOC_UPDATE", map[string]any{"pageId": "marker"}, "pages")
	if f := b.expect("DOC_UPDATE"); !strings.Contains(string(f.D), "marker") {
		t.Fatalf("got %s, want the visible DOC_UPDATE only", f.D)
	}
}

func TestDocAwarenessDrops(t *testing.T) {
	h := pagesHarness(t)
	c := h.dial()
	c.identify()

	c.send(opDocAwareness, awareness("hpages", "x", "e"))                        // no VIEW_CHANNEL
	c.send(opDocAwareness, awareness("text", "x", "e"))                          // not a pages channel
	c.send(opDocAwareness, awareness("nope", "x", "e"))                          // unknown channel
	c.send(opDocAwareness, awareness("pages", "x", strings.Repeat("a", 8193)))   // envelope too long
	c.send(opDocAwareness, awareness("pages", "max", strings.Repeat("a", 8192))) // at the cap: relayed
	if f := c.expect("DOC_AWARENESS"); !strings.Contains(string(f.D), `"pageId":"max"`) {
		t.Fatalf("got %s, want only the frame at the cap", f.D)
	}
}

func TestDocAwarenessRateLimit(t *testing.T) {
	h := pagesHarness(t)
	// The clock stands still for the first 40 frames, then moves 1 s: the
	// burst is exactly 20, and the 41st frame gets a refilled bucket. Only
	// the read loop of c calls it.
	t0, calls := time.Unix(1_000_000, 0), 0
	h.g.now = func() time.Time {
		calls++
		if calls > 40 {
			return t0.Add(time.Second)
		}
		return t0
	}
	c := h.dial()
	c.identify()
	for range 40 {
		c.send(opDocAwareness, awareness("pages", "p", "e"))
	}
	c.send(opDocAwareness, awareness("pages", "end", "e"))
	n := 0
	for {
		f := c.expect("DOC_AWARENESS")
		if strings.Contains(string(f.D), `"pageId":"end"`) {
			break
		}
		n++
	}
	if n != awarenessPerSecond {
		t.Errorf("relayed %d of 40 frames, want %d", n, awarenessPerSecond)
	}
}

func TestDocAwarenessDecodeErrorAndReadLimit(t *testing.T) {
	h := pagesHarness(t)
	c := h.dial()
	c.identify()
	c.send(opDocAwareness, "not an object")
	c.expectClose(closeDecodeError)

	c = h.dial()
	c.identify()
	big := `{"op":1,"d":"` + strings.Repeat("a", maxFrameBytes) + `"}`
	if err := c.ws.WriteMessage(websocket.TextMessage, []byte(big)); err != nil {
		t.Fatal(err)
	}
	c.expectClose(websocket.CloseMessageTooBig)
}
