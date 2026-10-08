package main

import (
	"strings"
	"testing"
)

// Soundboard and poke (contract §6): GUILD_SOUNDS_UPDATE reaches every member
// of the guild, and POKE passes through user:{id} to the target only.
func TestSoundsAndPokeDispatch(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.identify()

	h.pub("guild:"+gid, "GUILD_SOUNDS_UPDATE", map[string]string{"guildId": gid}, "")
	if f := c.expect("GUILD_SOUNDS_UPDATE"); !strings.Contains(string(f.D), `"guildId":"`+gid+`"`) {
		t.Fatalf("GUILD_SOUNDS_UPDATE %s", f.D)
	}

	h.pub("user:"+me, "POKE", map[string]any{"user": map[string]any{"id": "u2", "username": "bob", "avatar": nil}}, "")
	if f := c.expect("POKE"); !strings.Contains(string(f.D), `"username":"bob"`) {
		t.Fatalf("POKE %s", f.D)
	}
}
