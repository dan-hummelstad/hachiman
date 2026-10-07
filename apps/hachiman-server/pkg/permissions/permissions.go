// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Package permissions is the Go half of the Discord-style permission bitfield.
// Contract: docs/gateway-protocol.md §2. TS twin:
// pkgs/hachiman-client/src/permissions.ts — sync_test.go fails on any drift.
package permissions

const (
	CreateInstantInvite = 1 << 0
	KickMembers         = 1 << 1
	Administrator       = 1 << 3
	ManageChannels      = 1 << 4
	ManageGuild         = 1 << 5
	ViewChannel         = 1 << 10
	SendMessages        = 1 << 11
	ManageMessages      = 1 << 13
	AttachFiles         = 1 << 15
	ReadMessageHistory  = 1 << 16
	Connect             = 1 << 20
	Speak               = 1 << 21
	MuteMembers         = 1 << 22
	DeafenMembers       = 1 << 23
	MoveMembers         = 1 << 24
	ChangeNickname      = 1 << 26
	ManageNicknames     = 1 << 27
	ManageRoles         = 1 << 28
	ManageEvents        = 1 << 29
)

// ByName maps the TS constant names to their values; the sync test walks it.
var ByName = map[string]int64{
	"CREATE_INSTANT_INVITE": CreateInstantInvite,
	"KICK_MEMBERS":          KickMembers,
	"ADMINISTRATOR":         Administrator,
	"MANAGE_CHANNELS":       ManageChannels,
	"MANAGE_GUILD":          ManageGuild,
	"VIEW_CHANNEL":          ViewChannel,
	"SEND_MESSAGES":         SendMessages,
	"MANAGE_MESSAGES":       ManageMessages,
	"ATTACH_FILES":          AttachFiles,
	"READ_MESSAGE_HISTORY":  ReadMessageHistory,
	"CONNECT":               Connect,
	"SPEAK":                 Speak,
	"MUTE_MEMBERS":          MuteMembers,
	"DEAFEN_MEMBERS":        DeafenMembers,
	"MOVE_MEMBERS":          MoveMembers,
	"CHANGE_NICKNAME":       ChangeNickname,
	"MANAGE_NICKNAMES":      ManageNicknames,
	"MANAGE_ROLES":          ManageRoles,
	"MANAGE_EVENTS":         ManageEvents,
}

// All is the OR of every defined bit.
var All = func() int64 {
	var p int64
	for _, v := range ByName {
		p |= v
	}
	return p
}()

const (
	DefaultEveryone = ViewChannel | SendMessages | AttachFiles | ReadMessageHistory | Connect | Speak | CreateInstantInvite | ChangeNickname
	DM              = ViewChannel | SendMessages | AttachFiles | ReadMessageHistory
)

// Overwrite is one channel permission overwrite. Type is "role" or "member".
type Overwrite struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Allow int64  `json:"allow"`
	Deny  int64  `json:"deny"`
}

// Has reports whether every bit of bit is set in p.
func Has(p, bit int64) bool { return p&bit == bit }

// ComputeBase returns the member's guild-level permissions. roles maps role
// id → permissions and must include @everyone (id == guildID).
func ComputeBase(guildID, ownerID, userID string, memberRoles []string, roles map[string]int64) int64 {
	if userID == ownerID {
		return All
	}
	p := roles[guildID]
	for _, id := range memberRoles {
		p |= roles[id]
	}
	if p&Administrator != 0 {
		return All
	}
	return p
}

// ComputeChannel applies the channel's overwrites on top of ComputeBase.
// Returns 0 when the result lacks VIEW_CHANNEL.
func ComputeChannel(guildID, ownerID, userID string, memberRoles []string, roles map[string]int64, ows []Overwrite) int64 {
	base := ComputeBase(guildID, ownerID, userID, memberRoles, roles)
	if base&Administrator != 0 {
		return All
	}
	p := base
	for _, o := range ows {
		if o.Type == "role" && o.ID == guildID {
			p = (p &^ o.Deny) | o.Allow
		}
	}
	var allow, deny int64
	for _, o := range ows {
		if o.Type == "role" && o.ID != guildID && contains(memberRoles, o.ID) {
			allow |= o.Allow
			deny |= o.Deny
		}
	}
	p = (p &^ deny) | allow
	for _, o := range ows {
		if o.Type == "member" && o.ID == userID {
			p = (p &^ o.Deny) | o.Allow
		}
	}
	if p&ViewChannel == 0 {
		return 0
	}
	return p
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
