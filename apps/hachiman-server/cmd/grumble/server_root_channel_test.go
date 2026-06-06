// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"io"
	"log"
	"testing"

	"mumble.info/grumble/pkg/database"
)

// newTestDBForRootChannel spins up an in-memory sqlite GrumbleDb and seeds a
// single vServer with its bootstrap rows (SuperUser, root channel, admin
// group + ACLs). Returns the server id so the test can construct a Server
// pointing at it.
//
// Mirrors `pkg/database.NewTestDB` (which lives in the database_test
// package and therefore isn't importable here). Kept local so this file is
// self-contained.
func newTestDBForRootChannel(t *testing.T) (*database.GrumbleDb, uint64) {
	t.Helper()
	db, err := database.NewDB(&database.DbConfig{
		Type: "sqlite",
		Conn: ":memory:",
	})
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if err := db.Init(); err != nil {
		t.Fatalf("db.Init: %v", err)
	}

	var sid uint64
	if err := db.Transaction(func(tx *database.DbTx) error {
		s, err := tx.ServerAdd()
		if err != nil {
			return err
		}
		sid = s.ServerID

		pw := database.UserPasswordHash{Hash: "sha1:1:2", KDFIterations: 0}
		if _, err := tx.ServerInit(sid, pw, false); err != nil {
			return err
		}
		// seedRootChannelACLs lives in cmd/grumble (server_seed.go); we use it
		// directly so the test exercises the same write set as the production
		// boot path in NewServer.
		return seedRootChannelACLs(tx, sid)
	}); err != nil {
		t.Fatalf("seed tx: %v", err)
	}

	return db, sid
}

// newMinimalServer wires the smallest possible Server that RootChannel()
// requires. Deliberately doesn't go through NewServer because:
//
//   - NewServer's whole point is to populate s.Channels at boot — we want a
//     server where Channels is EMPTY so RootChannel takes the repair branch.
//   - NewServer pulls in blobstore + logtarget global state that the
//     pkg-level test runner doesn't have set up.
//
// The fields RootChannel() reads are Id, DB, Channels and Logger; nothing
// else. (Fatalf goes through Logger.)
func newMinimalServer(id int64, db *database.GrumbleDb) *Server {
	return &Server{
		Id:       id,
		DB:       db,
		Channels: make(map[int]*Channel),
		Logger:   log.New(io.Discard, "[test] ", 0),
	}
}

// TestRootChannel_RepairLoadsACLsAndGroups locks in the contract that the
// RootChannel() repair path doesn't just create the in-memory Channel struct
// — it also LOADS ACLs and the admin group from the DB into it.
//
// Without that load step the bug class is: a brand-new vServer connects, the
// admin group exists in the DB but has zero in-memory members, and the
// SuperUser is rejected on the first write attempt because acl.HasPermission
// looks at the in-memory Group.Add map and sees no entries. The bug only
// resolves on the NEXT process restart, when NewServer's load loop runs.
func TestRootChannel_RepairLoadsACLsAndGroups(t *testing.T) {
	db, sid := newTestDBForRootChannel(t)
	s := newMinimalServer(int64(sid), db)

	// Channels map is empty — RootChannel must take the repair branch.
	if len(s.Channels) != 0 {
		t.Fatalf("precondition: Channels has %d entries, want 0", len(s.Channels))
	}

	root := s.RootChannel()
	if root == nil {
		t.Fatal("RootChannel returned nil")
	}
	if root.Id != 0 {
		t.Errorf("root.Id = %d, want 0", root.Id)
	}

	// Repair must have populated ACLs from the DB. seedRootChannelACLs writes
	// three rows (admin / auth / all) so the in-memory ACL list should match.
	if got := len(root.ACL.ACLs); got == 0 {
		t.Errorf("root.ACL.ACLs is empty after repair — admin group has no in-memory grants")
	}

	// And the admin group must be present in the in-memory Group map with
	// SuperUser (UserID 0) marked as a member, OR the GroupGetByChannel
	// load step is broken.
	adminGroup, ok := root.ACL.Groups["admin"]
	if !ok {
		t.Fatalf("admin group missing from in-memory root channel; got groups=%v", keys(root.ACL.Groups))
	}
	if !adminGroup.Add[0] {
		t.Errorf("SuperUser (UserID 0) not in admin.Add map; got %v", adminGroup.Add)
	}

	// Subsequent calls return the cached in-memory Channel (no second repair).
	root2 := s.RootChannel()
	if root2 != root {
		t.Errorf("RootChannel returned a different *Channel on second call (%p vs %p) — repair ran twice", root, root2)
	}
}

// TestRootChannel_HappyPathSkipsRepair confirms that the repair branch is
// only taken when the in-memory channel is missing — if the load step in
// NewServer already populated s.Channels[0], RootChannel must be a pure
// map lookup with no DB hit.
func TestRootChannel_HappyPathSkipsRepair(t *testing.T) {
	db, sid := newTestDBForRootChannel(t)
	s := newMinimalServer(int64(sid), db)

	// Pre-populate s.Channels[0] the way NewServer's load loop would.
	preExisting := &Channel{Id: 0, Name: "Root"}
	s.Channels[0] = preExisting

	root := s.RootChannel()
	if root != preExisting {
		t.Errorf("RootChannel returned a new *Channel (%p) instead of the pre-populated one (%p)", root, preExisting)
	}
}

// Tiny helper used by error messages only.
func keys[K comparable, V any](m map[K]V) []K {
	out := make([]K, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
