// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package permissions

import "testing"

func TestComputeChannel(t *testing.T) {
	const g, owner, me, mod = "g", "owner", "me", "mod"
	roles := map[string]int64{g: DefaultEveryone, mod: ManageMessages, "admin": Administrator}
	hideEveryone := Overwrite{ID: g, Type: "role", Deny: ViewChannel}
	cases := []struct {
		name string
		user string
		mine []string
		ows  []Overwrite
		want int64
	}{
		{"owner bypasses everything", owner, nil, []Overwrite{hideEveryone}, All},
		{"admin role bypasses overwrites", me, []string{"admin"}, []Overwrite{hideEveryone}, All},
		{"plain member gets @everyone", me, nil, nil, DefaultEveryone},
		{"role perms are ORed in", me, []string{mod}, nil, DefaultEveryone | ManageMessages},
		{"@everyone deny hides channel", me, nil, []Overwrite{hideEveryone}, 0},
		{"role allow beats @everyone deny", me, []string{mod},
			[]Overwrite{hideEveryone, {ID: mod, Type: "role", Allow: ViewChannel}}, DefaultEveryone | ManageMessages},
		{"member overwrite beats role", me, []string{mod},
			[]Overwrite{{ID: mod, Type: "role", Allow: ViewChannel}, {ID: me, Type: "member", Deny: SendMessages}},
			(DefaultEveryone | ManageMessages) &^ SendMessages},
		{"role overwrite for role I lack is ignored", me, nil,
			[]Overwrite{hideEveryone, {ID: mod, Type: "role", Allow: ViewChannel}}, 0},
		{"VIEW_CHANNEL gate zeroes everything", me, nil,
			[]Overwrite{{ID: me, Type: "member", Deny: ViewChannel, Allow: ManageChannels}}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ComputeChannel(g, owner, c.user, c.mine, roles, c.ows); got != c.want {
				t.Errorf("got %b, want %b", got, c.want)
			}
		})
	}
}

func TestAllIncludesEveryBit(t *testing.T) {
	if !Has(All, ManageRoles|Administrator|CreateInstantInvite) || All>>31 != 0 {
		t.Fatalf("All = %b", All)
	}
}
