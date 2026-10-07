package main

import (
	"strings"
	"testing"
)

// Pins, guild events and blocks (contract §6): CHANNEL_PINS_UPDATE follows
// VIEW_CHANNEL like a message, GUILD_EVENT_* reach every member, and
// USER_BLOCK_UPDATE passes through user:{id}.
func TestPinsEventsAndBlocksDispatch(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.identify()

	pins := func(ch string) map[string]string { return map[string]string{"channelId": ch, "guildId": gid} }
	h.pub("guild:"+gid, "CHANNEL_PINS_UPDATE", pins("secret"), "secret")
	h.pub("guild:"+gid, "CHANNEL_PINS_UPDATE", pins("text"), "text")
	if f := c.expect("CHANNEL_PINS_UPDATE"); !strings.Contains(string(f.D), `"channelId":"text"`) {
		t.Fatalf("got %s, want the visible channel only", f.D)
	}

	event := map[string]any{"id": "e1", "guildId": gid, "channelId": "voice", "title": "Scrims", "startsAt": "2026-10-08T21:00:00Z", "rsvpCount": 0}
	for _, name := range []string{"GUILD_EVENT_CREATE", "GUILD_EVENT_UPDATE"} {
		h.pub("guild:"+gid, name, event, "")
		if f := c.expect(name); !strings.Contains(string(f.D), `"title":"Scrims"`) {
			t.Fatalf("%s %s", name, f.D)
		}
	}
	h.pub("guild:"+gid, "GUILD_EVENT_RSVP", map[string]any{"eventId": "e1", "guildId": gid, "userId": "u2", "going": true, "rsvpCount": 1}, "")
	if f := c.expect("GUILD_EVENT_RSVP"); !strings.Contains(string(f.D), `"rsvpCount":1`) {
		t.Fatalf("GUILD_EVENT_RSVP %s", f.D)
	}
	h.pub("guild:"+gid, "GUILD_EVENT_DELETE", map[string]string{"id": "e1", "guildId": gid}, "")
	c.expect("GUILD_EVENT_DELETE")

	h.pub("user:"+me, "USER_BLOCK_UPDATE", map[string]any{"userId": "u2", "blocked": true}, "")
	if f := c.expect("USER_BLOCK_UPDATE"); !strings.Contains(string(f.D), `"blocked":true`) {
		t.Fatalf("USER_BLOCK_UPDATE %s", f.D)
	}
}
