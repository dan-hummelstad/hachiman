// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"io"
	"log"
	"testing"
	"time"

	"mumble.info/grumble/pkg/sessionpool"
)

// TestPendingReclaim_HoldsUntilSessionEnded locks in HIGH #4: a Mumble
// session number is NOT returned to the pool when the client disconnects;
// it stays in pendingReclaim until SessionEnded arrives. A fresh client
// arriving in between gets a DIFFERENT session.
func TestPendingReclaim_HoldsUntilSessionEnded(t *testing.T) {
	s := &Server{
		Id:             1,
		Logger:         log.New(io.Discard, "", 0),
		pool:           sessionpool.New(),
		pendingReclaim: make(map[uint32]time.Time),
	}

	// Allocate a session via the pool, then "disconnect" it through the
	// pendingReclaim path.
	first := s.pool.Get()
	s.pendingReclaim[first] = time.Now()

	// A fresh client arriving NOW must not get the same session.
	second := s.pool.Get()
	if second == first {
		t.Fatalf("session collision: pool returned %d twice while %d was pending reclaim", second, first)
	}

	// SessionEnded arrives — now the original session is recyclable.
	s.reclaimPendingSession(first)
	if _, ok := s.pendingReclaim[first]; ok {
		t.Errorf("reclaimPendingSession did not clear pendingReclaim entry")
	}

	// Reclaim again is a no-op (idempotent).
	s.reclaimPendingSession(first)
}

// TestPendingReclaim_SweeperForcesTimeout locks in the safety-net path:
// if SessionEnded never arrives (partition / lost envelope) the sweeper
// forcibly returns the session to the pool after pendingReclaimTimeout.
func TestPendingReclaim_SweeperForcesTimeout(t *testing.T) {
	s := &Server{
		Id:             1,
		Logger:         log.New(io.Discard, "", 0),
		pool:           sessionpool.New(),
		pendingReclaim: make(map[uint32]time.Time),
	}

	session := s.pool.Get()
	// Backdate the entry past the timeout.
	s.pendingReclaim[session] = time.Now().Add(-pendingReclaimTimeout - time.Second)

	s.sweepPendingReclaims()

	if _, ok := s.pendingReclaim[session]; ok {
		t.Errorf("sweepPendingReclaims did not reclaim stale entry for session %d", session)
	}
}

// TestPendingReclaim_FreshEntryNotSweptYet locks in that an entry younger
// than the timeout stays in the pending map.
func TestPendingReclaim_FreshEntryNotSweptYet(t *testing.T) {
	s := &Server{
		Id:             1,
		Logger:         log.New(io.Discard, "", 0),
		pool:           sessionpool.New(),
		pendingReclaim: make(map[uint32]time.Time),
	}

	session := s.pool.Get()
	s.pendingReclaim[session] = time.Now()

	s.sweepPendingReclaims()

	if _, ok := s.pendingReclaim[session]; !ok {
		t.Errorf("sweepPendingReclaims swept a fresh entry; session %d gone", session)
	}
}
