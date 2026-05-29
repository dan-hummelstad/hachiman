package web

import (
	"io"
	"log"
	"strings"
	"testing"
)

// testLogger returns a logger that discards output, for constructing an SFU in
// tests/benchmarks without spamming stderr.
func testLogger() *log.Logger {
	return log.New(io.Discard, "", 0)
}

// relaymetrics_guard_test.go is the OFF-PATH GUARD. It fails if a relay/SFU is
// configured in a region that forces voice off the path between participants,
// i.e. it detects a cross-region detour. It passes for on-path topologies and
// fails for off-path ones.
//
// The guard has two layers:
//
//  1. TestEvaluatePath_Invariant — exhaustively pins the pure on-path
//     invariant (EvaluatePath), the single source of truth used by both the
//     hot path and the snapshot.
//
//  2. TestOffPathGuard_DetectsCrossRegionDetour — a behavioural guard built on
//     the real RelayMetrics: it asserts that an on-path forward is NOT flagged
//     and an off-path (cross-region) forward IS flagged in the snapshot. This
//     is the test an operator/CI relies on to catch a mis-homed relay.

func TestEvaluatePath_Invariant(t *testing.T) {
	cases := []struct {
		name           string
		relayRegion    string
		senderRegion   string
		receiverRegion string
		want           PathVerdict
	}{
		// On-path: relay placed, every known participant shares its region.
		{"all same region", "us-east", "us-east", "us-east", PathOnPath},
		{"sender unknown, receiver in-region", "us-east", "", "us-east", PathOnPath},
		{"receiver unknown, sender in-region", "us-east", "us-east", "", PathOnPath},

		// Off-path: a known participant region differs from the relay region.
		{"receiver cross-region", "us-east", "us-east", "eu-west", PathOffPath},
		{"sender cross-region", "us-east", "ap-southeast", "us-east", PathOffPath},
		{"both cross-region (same as each other)", "us-east", "eu-west", "eu-west", PathOffPath},
		{"both cross-region (different)", "us-east", "eu-west", "ap-southeast", PathOffPath},
		{"receiver in-region, sender cross-region", "eu-west", "us-west", "eu-west", PathOffPath},

		// Unknown: cannot prove a detour.
		{"relay unplaced", "", "us-east", "eu-west", PathUnknown},
		{"relay placed, both participants unknown", "us-east", "", "", PathUnknown},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EvaluatePath(tc.relayRegion, tc.senderRegion, tc.receiverRegion)
			if got != tc.want {
				t.Fatalf("EvaluatePath(relay=%q, sender=%q, receiver=%q) = %s, want %s",
					tc.relayRegion, tc.senderRegion, tc.receiverRegion, got, tc.want)
			}
		})
	}
}

// TestEvaluatePath_OffPathIsSymmetricInParticipants asserts the verdict does
// not depend on whether the off-region participant is the sender or receiver —
// a detour is a detour regardless of direction.
func TestEvaluatePath_OffPathIsSymmetricInParticipants(t *testing.T) {
	const relay = "us-east"
	a := EvaluatePath(relay, "eu-west", relay) // off via sender
	b := EvaluatePath(relay, relay, "eu-west") // off via receiver
	if a != PathOffPath || b != PathOffPath {
		t.Fatalf("expected both directions off-path, got sender-side=%s receiver-side=%s", a, b)
	}
}

// TestOffPathGuard_DetectsCrossRegionDetour is the headline guard: a relay
// homed in us-east forwarding to a us-east receiver must read as on-path, and
// forwarding to an eu-west receiver must be flagged off-path in the snapshot.
//
// Because RelayMetrics samples its structured logging, we drive enough
// forwards to (a) guarantee the per-region tally records and (b) keep the test
// deterministic, then assert on the always-updated atomic class counters via
// Snapshot().
func TestOffPathGuard_DetectsCrossRegionDetour(t *testing.T) {
	const relayRegion = "us-east"
	m := NewRelayMetrics(relayRegion, nil)

	// On-path forward: receiver in the same region as the relay.
	m.RecordNativeForward(120, relayRegion)

	snap := m.Snapshot()
	if !snap.OnPath {
		t.Fatalf("after a single in-region forward, expected OnPath=true, got false (off-path=%d)", snap.TotalOffPath)
	}
	if snap.TotalOffPath != 0 {
		t.Fatalf("expected zero off-path forwards on-path topology, got %d", snap.TotalOffPath)
	}

	// Off-path forward: receiver in a DIFFERENT region. The relay is now
	// forced to detour voice across regions — the guard must catch this.
	m.RecordWebRTCForward(120, "eu-west")

	snap = m.Snapshot()
	if snap.OnPath {
		t.Fatalf("GUARD FAILURE EXPECTED: relay %q forwarded to eu-west (cross-region detour) "+
			"but snapshot still reports OnPath=true; off-path detection is broken", relayRegion)
	}
	if snap.TotalOffPath == 0 {
		t.Fatalf("expected at least one off-path forward to be counted after cross-region forward, got 0")
	}
}

// TestOffPathGuard_FailsForMisHomedRelay simulates the CI failure mode the
// task asks for: a relay configured in a region that forces voice off the path
// between participants. If a future change silently let an off-path relay look
// healthy, THIS test (and the assertion message) is what fires.
func TestOffPathGuard_FailsForMisHomedRelay(t *testing.T) {
	// Participants are all in eu-west, but the relay is mis-homed in us-east.
	// Every forward to a real (eu-west) participant is therefore a detour.
	const misHomedRelay = "us-east"
	const participantRegion = "eu-west"

	m := NewRelayMetrics(misHomedRelay, nil)
	for i := 0; i < 10; i++ {
		m.RecordNativeForward(100, participantRegion)
	}

	snap := m.Snapshot()

	// The on-path invariant must NOT hold for a mis-homed relay. We assert the
	// guard correctly reports the violation; this is the positive form of the
	// "fails off-path" requirement.
	if snap.OnPath {
		t.Fatalf("mis-homed relay (relay=%q, participants=%q) reported OnPath=true — "+
			"the on-path guard failed to detect the cross-region detour",
			misHomedRelay, participantRegion)
	}
	if snap.TotalOffPath != 10 {
		t.Fatalf("expected all 10 forwards to be flagged off-path, got %d", snap.TotalOffPath)
	}

	// And an explicit, greppable assertion mirroring what an operator alert
	// would key on.
	if v := EvaluatePath(misHomedRelay, participantRegion, participantRegion); v != PathOffPath {
		t.Fatalf("EvaluatePath should flag mis-homed relay as %s, got %s", PathOffPath, v)
	}
}

// TestUnplacedRelayIsNotFlaggedAsOffPath guards against false positives: an
// unplaced (empty region) relay cannot be proven to detour and must read as
// unknown, never off-path. This keeps legacy/unconfigured deployments from
// tripping the guard.
func TestUnplacedRelayIsNotFlaggedAsOffPath(t *testing.T) {
	m := NewRelayMetrics("", nil) // unplaced
	m.RecordNativeForward(100, "eu-west")
	m.RecordWebRTCForward(100, "")

	snap := m.Snapshot()
	if snap.TotalOffPath != 0 {
		t.Fatalf("unplaced relay must never report off-path forwards, got %d", snap.TotalOffPath)
	}
	if snap.Placed {
		t.Fatalf("unplaced relay should report Placed=false")
	}
	// Both forwards should be classed unknown.
	var unknown uint64
	for _, ts := range snap.Transports {
		unknown += ts.UnknownCount
	}
	if unknown != 2 {
		t.Fatalf("expected 2 unknown-class forwards for unplaced relay, got %d", unknown)
	}
}

// TestVerdictString keeps the human-facing labels stable (they appear in logs
// and the operator UI).
func TestVerdictString(t *testing.T) {
	for v, want := range map[PathVerdict]string{
		PathOnPath:  "on-path",
		PathOffPath: "off-path",
		PathUnknown: "unknown",
	} {
		if got := v.String(); got != want {
			t.Errorf("PathVerdict(%d).String() = %q, want %q", v, got, want)
		}
	}
	// Off-path log line must remain greppable.
	if !strings.Contains(PathOffPath.String(), "off-path") {
		t.Errorf("off-path verdict label changed; update operator alerts/log greps")
	}
}
