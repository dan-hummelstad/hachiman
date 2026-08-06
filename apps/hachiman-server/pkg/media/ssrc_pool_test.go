// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package media

import "testing"

// TestSSRCPool_GetReturnsSession locks in CRITICAL #1: the SSRC IS the
// session. Both control (UserState.Ssrc broadcast) and media (SFU RTP
// forwarding) depend on this identity; if Get returned a counter-based value
// receivers couldn't correlate audio to users.
func TestSSRCPool_GetReturnsSession(t *testing.T) {
	p := NewSSRCPool()

	if got := p.Get(7); got != 7 {
		t.Errorf("Get(7) = %d, want 7", got)
	}
	if got := p.Get(42); got != 42 {
		t.Errorf("Get(42) = %d, want 42", got)
	}
	if got := p.Get(7); got != 7 {
		t.Errorf("Get(7) idempotent: got %d, want 7", got)
	}
}

// TestSSRCPool_ReleaseAndReGet verifies that a Release-then-Get cycle returns
// the same value (the session itself), not a "free-list" lookalike from the
// old counter implementation.
func TestSSRCPool_ReleaseAndReGet(t *testing.T) {
	p := NewSSRCPool()
	p.Get(100)
	p.Release(100)
	if got := p.Get(100); got != 100 {
		t.Errorf("Get(100) after Release: got %d, want 100", got)
	}
}

// TestSSRCPool_LookupHelpers covers the SSRCForSession / SessionForSSRC pair.
func TestSSRCPool_LookupHelpers(t *testing.T) {
	p := NewSSRCPool()
	p.Get(9)

	if ssrc, ok := p.SSRCForSession(9); !ok || ssrc != 9 {
		t.Errorf("SSRCForSession(9) = (%d, %v), want (9, true)", ssrc, ok)
	}
	if sess, ok := p.SessionForSSRC(9); !ok || sess != 9 {
		t.Errorf("SessionForSSRC(9) = (%d, %v), want (9, true)", sess, ok)
	}
	if _, ok := p.SSRCForSession(404); ok {
		t.Errorf("SSRCForSession(404) on unassigned session returned ok=true")
	}
}

// TestSSRCPool_ReleaseIdempotent guards against the Reclaim path firing
// twice (HIGH #4) corrupting pool state.
func TestSSRCPool_ReleaseIdempotent(t *testing.T) {
	p := NewSSRCPool()
	p.Get(1)
	p.Release(1)
	p.Release(1) // no panic, no spurious state
	if _, ok := p.SSRCForSession(1); ok {
		t.Errorf("SSRCForSession(1) after double Release: still assigned")
	}
}
