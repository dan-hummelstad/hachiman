// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"math/rand"
	"testing"
	"time"
)

// TestNextBackoff covers the reconnect-backoff growth, the cap, and the jitter
// bounds. Locks in MEDIUM #4 — without these properties, a control flap would
// synchronise the fleet into a thundering herd.
func TestNextBackoff(t *testing.T) {
	t.Parallel()

	// Deterministic RNG so the jitter range can be asserted reproducibly.
	rng := rand.New(rand.NewSource(1))

	// First doubling from the minimum should land near 2s ± 25%.
	got := nextBackoff(sidechannelReconnectBackoffMin, rng)
	if got < 1500*time.Millisecond || got > 2500*time.Millisecond {
		t.Errorf("first nextBackoff from min: got %v, want in [1.5s, 2.5s]", got)
	}

	// The doubling sequence must cap at the max with jitter applied. We feed
	// the max directly so the cap is exercised; the jittered result must
	// still land within ±25% of max.
	got = nextBackoff(sidechannelReconnectBackoffMax, rng)
	if got < 22500*time.Millisecond || got > 37500*time.Millisecond {
		t.Errorf("nextBackoff at cap: got %v, want in [22.5s, 37.5s]", got)
	}

	// And feeding well above max also caps (an out-of-band caller couldn't
	// push the next attempt to 60s+).
	got = nextBackoff(60*time.Second, rng)
	if got > 37500*time.Millisecond {
		t.Errorf("nextBackoff above cap: got %v, want ≤ 37.5s (= max + 25%% jitter)", got)
	}

	// The floor must hold: even with maximally-negative jitter the result is
	// never below the min. Drive 200 iterations to exhaust the jitter range.
	for i := 0; i < 200; i++ {
		d := nextBackoff(sidechannelReconnectBackoffMin, rng)
		if d < sidechannelReconnectBackoffMin {
			t.Fatalf("nextBackoff returned %v < min %v on iteration %d",
				d, sidechannelReconnectBackoffMin, i)
		}
	}
}
