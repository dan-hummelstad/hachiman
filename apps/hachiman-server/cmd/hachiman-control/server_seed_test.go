// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"testing"
)

// TestShouldGrantOracleAdmin exhaustively covers the table of (configured
// AdminOracleUserID, introspected `sub`) pairs handleAuthenticate consults
// when deciding whether to set client.superUser.
//
// Why this is its own table-driven test rather than a stub harness around
// handleAuthenticate: the full Authenticate flow needs a TLS conn, a fake
// AS for introspection, plus the protobuf wire dance. (The legacy OCB
// `cryptstate` setup was deleted in phase 1 step 3 along with the native
// UDP voice path, so it's no longer part of the flow.) The grant decision
// itself is one pure boolean — testing it in isolation is what lets us be
// confident about the edge cases that matter (empty-vs-empty, whitespace,
// case sensitivity).
func TestShouldGrantOracleAdmin(t *testing.T) {
	cases := []struct {
		name             string
		configuredAdmin  string
		introspectedSub  string
		want             bool
	}{
		// The happy path — managed-mode owner grant.
		{"exact UUID match", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", true},

		// Empty configured admin: any token, including one with an empty
		// sub, MUST NOT grant. Self-hosted servers leave AdminOracleUserID
		// blank in DefaultCfg and would otherwise be at risk of every
		// anonymously-introspected token matching the empty-vs-empty case.
		{"both empty (self-host default)", "", "", false},
		{"empty admin, non-empty sub", "", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", false},
		{"whitespace-only admin, empty sub", "   ", "", false},
		{"whitespace-only admin, non-empty sub", "   ", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", false},

		// Non-empty admin paired with mismatching sub: rejected. This is the
		// "I'm an Oracle-verified user but not the admin of THIS vServer"
		// case — the most common production-mode rejection.
		{"non-empty admin, empty sub", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", "", false},
		{"distinct UUIDs", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", "00000000-0000-0000-0000-000000000000", false},

		// Whitespace tolerance on the configured side (round-trip through
		// gRPC + config table + paste-with-newline is a real failure mode
		// the operator has no way to debug from the client side).
		{"trailing newline in config", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b\n", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", true},
		{"leading + trailing spaces in config", "  8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b  ", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", true},

		// We deliberately do NOT trim the introspected sub — that's a value
		// the AS controls and tampering would be a server bug we want to
		// surface, not silently accept.
		{"trailing newline in sub does not match", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b", "8b3c8c4a-2c33-4d28-9aef-2c1c0d4d2b6b\n", false},

		// Case-sensitive comparison. Oracle hands out lowercase UUIDs but
		// the storage column is case-insensitive on Postgres CITEXT — so a
		// mixed-case stored value would be returned as-is and SHOULD fail
		// to match a strictly-lowercase token sub. (Better to fail the
		// grant than to silently accept a typo.)
		{"case mismatch", "ABCDEF", "abcdef", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldGrantOracleAdmin(tc.configuredAdmin, tc.introspectedSub)
			if got != tc.want {
				t.Errorf("shouldGrantOracleAdmin(%q, %q) = %v, want %v",
					tc.configuredAdmin, tc.introspectedSub, got, tc.want)
			}
		})
	}
}
