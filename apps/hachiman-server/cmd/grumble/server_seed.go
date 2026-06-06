// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"strings"

	"mumble.info/grumble/pkg/acl"
	"mumble.info/grumble/pkg/database"
)

// shouldGrantOracleAdmin decides whether a successfully-introspected Oracle
// token should be promoted to SuperUser on this vServer.
//
// Returns true iff BOTH of the following hold:
//
//  1. `configuredAdminID` (the per-vServer AdminOracleUserID config, set at
//     CreateVirtualServer time) is non-empty after trimming whitespace.
//  2. The trimmed configured id matches `introspectedSub` exactly.
//
// The empty-vs-empty case (a vServer with no admin configured paired with a
// token whose `sub` claim happens to be empty) MUST NOT grant — that's a
// defense-in-depth footgun for self-hosted servers that leave
// AdminOracleUserID at its DefaultCfg empty.
//
// Whitespace-tolerance is intentional: the value is round-tripped through
// gRPC + a config-table string column + a Postgres VARCHAR, and operators
// have been known to paste with trailing newlines.
//
// Pure & deterministic — exercised by TestShouldGrantOracleAdmin.
func shouldGrantOracleAdmin(configuredAdminID, introspectedSub string) bool {
	trimmed := strings.TrimSpace(configuredAdminID)
	if trimmed == "" {
		return false
	}
	return trimmed == introspectedSub
}

// seedRootChannelACLs writes the canonical per-vServer ACL rows on the root
// channel (ChannelID=0). These three entries mirror the Murmur "fresh server"
// default and are the minimum needed for self-host to be immediately usable:
//
//   - priority 1: admin group has +Write on root + subchannels
//     (the SuperUser is always a member of admin, see ServerInit)
//   - priority 2: auth group can create temp channels anywhere
//   - priority 3: all group can self-register at the root
//
// Every row is upserted on (server_id, channel_id, priority), so calling this
// twice on the same vServer is a safe no-op — important because both the boot
// path (NewServer when len(servers)==0) AND the gRPC CreateVirtualServer path
// run this. The defense-in-depth fallback in Server.RootChannel also calls
// this on its repair-on-demand path.
func seedRootChannelACLs(tx *database.DbTx, sid uint64) error {
	rows := []database.ACL{
		database.NewACL(sid, 0, 1).WithGroup("admin").Apply(true, true).Grant(acl.WritePermission),
		database.NewACL(sid, 0, 2).WithGroup("auth").Apply(true, true).Grant(acl.TempChannelPermission),
		database.NewACL(sid, 0, 3).WithGroup("all").Apply(true, false).Grant(acl.SelfRegisterPermission),
	}
	for _, row := range rows {
		if err := tx.ACLAdd(row); err != nil {
			return err
		}
	}
	return nil
}
