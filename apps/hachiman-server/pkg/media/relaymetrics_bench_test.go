package media

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v3"
)

// relaymetrics_bench_test.go establishes the "THIN" baseline: how much latency
// the SFU/bridge forwarding hop adds, plus proof that the on-path
// instrumentation itself is negligible.
//
// Run:
//
//	GOCACHE="$TMPDIR/gocache" go test ./pkg/media/ -run x -bench 'Forward|Metrics|Hop' -benchmem
//
// The numbers feed DefaultHopLatencyBudget and the "thin" budget discussion in
// THIN-RELAY-DESIGN.md. They are also a regression guard: if the per-forward
// cost or allocation count jumps, the relay is no longer thin.

// makeOpusFrame returns a representative ~20ms Opus voice payload. Sized in the
// typical 40–120 byte range for speech; content is irrelevant for the hop.
func makeOpusFrame(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

// BenchmarkForwardToWebRTC_Hop measures the end-to-end cost of a single
// ForwardToWebRTC call against a real pion TrackLocalStaticRTP — this is the
// actual SFU forwarding hop (RTP header stamp + WriteRTP) plus the added
// instrumentation. ns/op is the relay's per-packet added CPU latency baseline.
//
// Note: with no negotiated PeerConnection / bound RTP sender, WriteRTP on an
// unbound track is a no-op that returns nil, so this isolates the SFU's own
// per-packet work (the part the relay controls) from kernel/NIC send time. The
// native-UDP path's send time is measured separately at runtime via
// ObserveHopLatency.
func BenchmarkForwardToWebRTC_Hop(b *testing.B) {
	sfu := NewSFU(testLogger(), "us-east")
	const senderSSRC = 42

	wc := &WebRTCClient{
		Session:   1,
		SSRC:      99,
		outTracks: make(map[uint32]*webrtc.TrackLocalStaticRTP),
		rtpState:  make(map[uint32]*rtpForwardState),
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		"audio-bench", "stream-bench",
	)
	if err != nil {
		b.Fatalf("new track: %v", err)
	}
	wc.outTracks[senderSSRC] = track

	payload := makeOpusFrame(80)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sfu.ForwardToWebRTC(wc, senderSSRC, payload, uint64(i), "us-east")
	}
}

// BenchmarkRecordForward_OnPath isolates the on-path instrumentation cost (the
// part this work added to the hot path). It must be a handful of ns/op with
// ZERO allocations — that is the proof the instrumentation is "thin".
func BenchmarkRecordForward_OnPath(b *testing.B) {
	m := NewRelayMetrics("us-east", nil) // nil logger: exercise counters only

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m.RecordWebRTCForward(80, "us-east")
	}
}

// BenchmarkRecordForward_OffPath does the same for the off-path class, ensuring
// the cross-region branch is equally allocation-free on the hot path (the
// sampled logging/map work is excluded by the nil logger + amortised sampling).
func BenchmarkRecordForward_OffPath(b *testing.B) {
	m := NewRelayMetrics("us-east", nil)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m.RecordNativeForward(80, "eu-west")
	}
}

// BenchmarkObserveHopLatency isolates the atomic latency-accumulation cost.
func BenchmarkObserveHopLatency(b *testing.B) {
	m := NewRelayMetrics("us-east", nil)
	d := 250 * time.Microsecond

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m.ObserveHopLatency(d)
	}
}

// BenchmarkRecordForward_Parallel models many concurrent forwarding goroutines
// (one per receiver track) hammering the shared counters, to confirm the
// atomics don't become a contention/latency hot spot under fan-out.
func BenchmarkRecordForward_Parallel(b *testing.B) {
	m := NewRelayMetrics("us-east", nil)
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			m.RecordWebRTCForward(80, "us-east")
		}
	})
}

// TestInstrumentationAllocFree is a hard CI gate (not just a benchmark): it
// asserts the per-forward hot-path entry points perform ZERO heap allocations.
// This is the automated enforcement of the "no per-packet heap allocation in
// the hot path" guardrail.
func TestInstrumentationAllocFree(t *testing.T) {
	m := NewRelayMetrics("us-east", nil)

	onPath := testing.AllocsPerRun(2000, func() {
		m.RecordWebRTCForward(80, "us-east")
	})
	if onPath != 0 {
		t.Fatalf("RecordWebRTCForward (on-path) allocates %.2f times/op; hot path must be alloc-free", onPath)
	}

	offPath := testing.AllocsPerRun(2000, func() {
		m.RecordNativeForward(80, "eu-west")
	})
	if offPath != 0 {
		t.Fatalf("RecordNativeForward (off-path) allocates %.2f times/op; hot path must be alloc-free", offPath)
	}

	hop := testing.AllocsPerRun(2000, func() {
		m.ObserveHopLatency(200 * time.Microsecond)
	})
	if hop != 0 {
		t.Fatalf("ObserveHopLatency allocates %.2f times/op; hot path must be alloc-free", hop)
	}

	// EvaluatePath is pure and must not allocate either (called from tests and
	// usable on the hot path).
	ev := testing.AllocsPerRun(2000, func() {
		_ = EvaluatePath("us-east", "us-east", "eu-west")
	})
	if ev != 0 {
		t.Fatalf("EvaluatePath allocates %.2f times/op; must be alloc-free", ev)
	}
}

// TestHopLatencyBudgetAccounting verifies over-budget observations are counted,
// which is what an operator alert on "relay no longer thin" keys off.
func TestHopLatencyBudgetAccounting(t *testing.T) {
	m := NewRelayMetrics("us-east", nil)
	m.SetBudget(1 * time.Millisecond)

	m.ObserveHopLatency(200 * time.Microsecond) // under budget
	m.ObserveHopLatency(5 * time.Millisecond)   // over budget
	m.ObserveHopLatency(2 * time.Millisecond)   // over budget

	snap := m.Snapshot()
	if snap.Hop.Samples != 3 {
		t.Fatalf("expected 3 hop samples, got %d", snap.Hop.Samples)
	}
	if snap.Hop.OverBudgetCount != 2 {
		t.Fatalf("expected 2 over-budget observations, got %d", snap.Hop.OverBudgetCount)
	}
	if snap.Hop.MaxNanos != uint64((5 * time.Millisecond).Nanoseconds()) {
		t.Fatalf("expected max 5ms, got %d ns", snap.Hop.MaxNanos)
	}
}
