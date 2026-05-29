package web

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// relaymetrics.go implements the "KEEP VOICE RELAYS THIN & ON-PATH"
// instrumentation. It answers two operational questions cheaply enough to run
// in production:
//
//  1. ON-PATH? — is voice forwarding staying within the region this relay is
//     homed in, or is it detouring across regions?
//  2. THIN?    — how much latency does the forwarding hop itself add?
//
// HOT-PATH CONTRACT: the per-packet entry points (RecordWebRTCForward,
// RecordNativeForward, observeHopLatency) perform ONLY atomic integer
// operations. They never allocate on the heap, never take a mutex, and never
// perform blocking I/O. Structured logging is sampled (every Nth forward)
// behind an atomic counter so that, even when enabled, at most one cheap log
// line is emitted per sampleEvery packets — never one per packet.
//
// No protobuf / wire-format changes are involved: regions are read from the
// existing serverconf "ServerRegion" key and surfaced over an HTTP JSON
// snapshot, both off the hot path.

// PathVerdict is the result of evaluating whether a single forwarding hop
// keeps voice on-path.
type PathVerdict int

const (
	// PathOnPath: the forward stays within the relay's region (or region
	// information is absent on both ends and so cannot be a detour).
	PathOnPath PathVerdict = iota
	// PathOffPath: the relay is homed in a region that differs from a
	// participant's region — voice is being detoured across regions.
	PathOffPath
	// PathUnknown: not enough region information to make a determination
	// (e.g. the relay is unplaced). Treated as on-path for counting (we do
	// not penalise unplaced relays) but surfaced separately for operators.
	PathUnknown
)

func (v PathVerdict) String() string {
	switch v {
	case PathOnPath:
		return "on-path"
	case PathOffPath:
		return "off-path"
	default:
		return "unknown"
	}
}

// EvaluatePath decides whether forwarding a voice packet from a sender in
// senderRegion to a receiver in receiverRegion, through a relay homed in
// relayRegion, keeps voice on-path.
//
// This is the single source of truth for the on-path invariant and is a PURE
// function (no allocation, no I/O) so it can be unit-tested exhaustively by
// the off-path guard test and called from the hot path.
//
// The invariant the platform wants to hold: "voice never crosses regions". A
// relay is on-path for a hop iff every participant whose region IS KNOWN
// shares the relay's region. If the relay itself is unplaced (empty region),
// or both participants are unplaced, we cannot prove a detour and return
// PathUnknown. If any known participant region differs from the relay's known
// region, that is a cross-region detour: PathOffPath.
//
// Empty string means "unplaced / region unknown" for any argument, mirroring
// the REGION-CONTRACT semantics for an empty ServerRegion / null
// servers.region.
func EvaluatePath(relayRegion, senderRegion, receiverRegion string) PathVerdict {
	if relayRegion == "" {
		// An unplaced relay cannot be proven to be detouring — there is no
		// region to compare against. Surface as unknown, not a violation.
		return PathUnknown
	}

	known := 0
	mismatch := false
	for _, p := range [2]string{senderRegion, receiverRegion} {
		if p == "" {
			continue
		}
		known++
		if p != relayRegion {
			mismatch = true
		}
	}

	if known == 0 {
		return PathUnknown
	}
	if mismatch {
		return PathOffPath
	}
	return PathOnPath
}

// pathClass is a compact hot-path classification used by the atomic counters.
// It avoids string handling in RecordWebRTCForward / RecordNativeForward.
type pathClass uint8

const (
	classOnPath pathClass = iota
	classOffPath
	classUnknown
	numPathClasses
)

// classifyHotPath is the allocation-free, branch-only classifier used on the
// hot path. It mirrors EvaluatePath but returns the compact pathClass and
// takes a precomputed "relay is placed" bool plus a single "receiver region
// matches relay region" bool, both of which the caller computes from values
// it already holds — so no map lookups or string compares are forced into the
// hot path beyond a single pointer/length comparison the caller does once.
func classifyHotPath(relayPlaced, receiverKnown, receiverMatches bool) pathClass {
	if !relayPlaced {
		return classUnknown
	}
	if !receiverKnown {
		return classUnknown
	}
	if !receiverMatches {
		return classOffPath
	}
	return classOnPath
}

// transport identifies which forwarding path a packet took.
type transport uint8

const (
	transportWebRTC transport = iota // native Mumble -> WebRTC via SFU
	transportNative                  // native Mumble -> native Mumble via UDP
	numTransports
)

// hopLatencyStats accumulates added-latency observations for the forwarding
// hop using only atomics. Values are nanoseconds. We keep sum + count for a
// running mean and a max via CAS; this is enough for a "thin" baseline without
// per-packet allocation or a histogram. count is bumped on every observation,
// so a sampled subset (or all) of forwards can feed it.
type hopLatencyStats struct {
	count   atomic.Uint64
	sumNs   atomic.Uint64
	maxNs   atomic.Uint64
	overBudgetCount atomic.Uint64 // observations exceeding budgetNs
}

func (h *hopLatencyStats) observe(d time.Duration, budgetNs uint64) {
	ns := uint64(d.Nanoseconds())
	h.count.Add(1)
	h.sumNs.Add(ns)
	if budgetNs > 0 && ns > budgetNs {
		h.overBudgetCount.Add(1)
	}
	// Lock-free max update.
	for {
		cur := h.maxNs.Load()
		if ns <= cur {
			return
		}
		if h.maxNs.CompareAndSwap(cur, ns) {
			return
		}
	}
}

// transportCounters holds per-transport atomic packet/byte counters and the
// per-path-class breakdown.
type transportCounters struct {
	packets    atomic.Uint64
	bytes      atomic.Uint64
	classCount [numPathClasses]atomic.Uint64
	drops      atomic.Uint64 // forwards that failed to write (best-effort path)
}

// RelayMetrics is the per-server relay instrumentation. One instance is owned
// by the SFU and shared with the native voice broadcaster so both forwarding
// paths report into the same counters.
//
// The region field is set once at construction (from cfg.StringValue
// ("ServerRegion")) and read-only thereafter, so it needs no synchronisation
// on the hot path. relayPlaced caches (region != "") to keep the hot path a
// plain bool read.
type RelayMetrics struct {
	region      string
	relayPlaced bool

	startedAt time.Time
	logger    *log.Logger

	transports [numTransports]transportCounters
	hop        hopLatencyStats

	// budgetNs is the "thin" latency budget for a single forwarding hop in
	// nanoseconds. Observations above it increment overBudgetCount and are
	// the trigger condition operators alert on. 0 disables budget tracking.
	budgetNs uint64

	// Sampling: a structured log line is emitted at most once every
	// sampleEvery forwards (atomic counter, no allocation when skipped).
	// sampleEvery == 0 disables sampled logging entirely.
	sampleEvery uint64
	sampleTick  atomic.Uint64

	// regionForwards tracks, off the hot path, how many forwards targeted
	// each distinct receiver region. This IS guarded by a mutex and is only
	// updated from the sampled path (never per packet) so it can use a map
	// without violating the hot-path no-alloc rule.
	mu             sync.Mutex
	regionForwards map[string]uint64
}

// DefaultHopLatencyBudget is the steady-state added-latency budget for a
// single thin forwarding hop. An on-host wake-proxy (localhost -> Murmur) and
// an in-region SFU should both sit comfortably under this; sustained breaches
// indicate the relay is no longer "thin" (CPU starvation, GC pauses, an
// accidental cross-region network hop, etc.). Tune against the benchmark
// baseline (see relaymetrics_bench_test.go and THIN-RELAY-DESIGN.md).
const DefaultHopLatencyBudget = 2 * time.Millisecond

// defaultSampleEvery: emit one structured path log per this many forwards.
// At 50 packets/sec/stream this is ~ one line every 20s per active stream —
// negligible, and zero cost (single atomic add + compare) when it doesn't fire.
const defaultSampleEvery = 1000

// NewRelayMetrics constructs relay metrics tagged with the given region.
// region should be cfg.StringValue("ServerRegion") ("" = unplaced). logger may
// be nil to disable sampled logging.
func NewRelayMetrics(region string, logger *log.Logger) *RelayMetrics {
	return &RelayMetrics{
		region:         region,
		relayPlaced:    region != "",
		startedAt:      time.Now(),
		logger:         logger,
		budgetNs:       uint64(DefaultHopLatencyBudget.Nanoseconds()),
		sampleEvery:    defaultSampleEvery,
		regionForwards: make(map[string]uint64),
	}
}

// Region returns the region this relay is homed in ("" = unplaced).
func (m *RelayMetrics) Region() string {
	if m == nil {
		return ""
	}
	return m.region
}

// SetBudget overrides the thin-hop latency budget (mainly for tests/tuning).
func (m *RelayMetrics) SetBudget(d time.Duration) {
	if m == nil {
		return
	}
	atomic.StoreUint64(&m.budgetNs, uint64(d.Nanoseconds()))
}

// budget reads the current budget atomically.
func (m *RelayMetrics) budget() uint64 {
	return atomic.LoadUint64(&m.budgetNs)
}

// RecordWebRTCForward records a single native-Mumble -> WebRTC forward.
//
// HOT PATH. Allocation-free: atomic adds only. receiverRegion comparison is a
// single string-equality the caller cannot avoid, but no map/heap work occurs.
// Pass the receiver's region ("" if unknown); senderRegion is implicitly the
// relay's region for forwards (the sender's audio is already on this relay).
func (m *RelayMetrics) RecordWebRTCForward(payloadLen int, receiverRegion string) {
	if m == nil {
		return
	}
	m.recordForward(transportWebRTC, payloadLen, receiverRegion)
}

// RecordNativeForward records a single native-Mumble -> native-Mumble (UDP)
// forward. HOT PATH; same no-alloc contract as RecordWebRTCForward.
func (m *RelayMetrics) RecordNativeForward(payloadLen int, receiverRegion string) {
	if m == nil {
		return
	}
	m.recordForward(transportNative, payloadLen, receiverRegion)
}

// recordForward is the shared hot-path counter update. NO ALLOCATION.
func (m *RelayMetrics) recordForward(t transport, payloadLen int, receiverRegion string) {
	tc := &m.transports[t]
	tc.packets.Add(1)
	if payloadLen > 0 {
		tc.bytes.Add(uint64(payloadLen))
	}

	receiverKnown := receiverRegion != ""
	// Single string compare; no allocation. Skipped entirely if unplaced.
	receiverMatches := receiverKnown && receiverRegion == m.region
	class := classifyHotPath(m.relayPlaced, receiverKnown, receiverMatches)
	tc.classCount[class].Add(1)

	// Sampled, allocation-light bookkeeping/logging. The fast path here is a
	// single atomic add + compare; the body runs only once per sampleEvery
	// forwards.
	if m.sampleEvery > 0 {
		if m.sampleTick.Add(1)%m.sampleEvery == 0 {
			m.sampledObserve(t, class, receiverRegion)
		}
	}
}

// RecordDrop records a best-effort forward that failed to write. HOT PATH
// (atomic only).
func (m *RelayMetrics) RecordDrop(t transport) {
	if m == nil {
		return
	}
	m.transports[t].drops.Add(1)
}

// RecordWebRTCDrop / RecordNativeDrop are typed convenience wrappers.
func (m *RelayMetrics) RecordWebRTCDrop() { m.RecordDrop(transportWebRTC) }
func (m *RelayMetrics) RecordNativeDrop() { m.RecordDrop(transportNative) }

// ObserveHopLatency records the added latency of one forwarding hop. Intended
// to be fed by a SAMPLED caller (e.g. inside the sampled branch) rather than
// per packet, but it is itself atomic-only and safe to call on the hot path if
// desired. NO ALLOCATION.
func (m *RelayMetrics) ObserveHopLatency(d time.Duration) {
	if m == nil {
		return
	}
	m.hop.observe(d, m.budget())
}

// sampledObserve runs once per sampleEvery forwards. It is OFF the strict hot
// path (1/sampleEvery duty cycle) and may take the mutex / touch the map / log.
func (m *RelayMetrics) sampledObserve(t transport, class pathClass, receiverRegion string) {
	// Per-region forward tally (map write guarded by mutex; rare).
	if receiverRegion != "" {
		m.mu.Lock()
		m.regionForwards[receiverRegion]++
		m.mu.Unlock()
	}

	if m.logger == nil {
		return
	}
	// One terse, structured line. This is the ONLY logging on the forwarding
	// path and it is rate-limited to 1/sampleEvery packets.
	m.logger.Printf(
		"relay-path transport=%s relay_region=%q receiver_region=%q verdict=%s",
		transportName(t), m.region, receiverRegion, classToVerdict(class),
	)

	if class == classOffPath {
		// Off-path is the invariant violation; make it greppable on its own.
		m.logger.Printf(
			"relay-OFF-PATH voice detoured: relay_region=%q receiver_region=%q transport=%s",
			m.region, receiverRegion, transportName(t),
		)
	}
}

func transportName(t transport) string {
	if t == transportWebRTC {
		return "webrtc"
	}
	return "native-udp"
}

func classToVerdict(c pathClass) PathVerdict {
	switch c {
	case classOnPath:
		return PathOnPath
	case classOffPath:
		return PathOffPath
	default:
		return PathUnknown
	}
}

// --- Snapshot (off hot path) ---------------------------------------------

// TransportSnapshot is a point-in-time read of one transport's counters.
type TransportSnapshot struct {
	Transport     string `json:"transport"`
	Packets       uint64 `json:"packets"`
	Bytes         uint64 `json:"bytes"`
	OnPathCount   uint64 `json:"onPathCount"`
	OffPathCount  uint64 `json:"offPathCount"`
	UnknownCount  uint64 `json:"unknownCount"`
	Drops         uint64 `json:"drops"`
}

// RelaySnapshot is a JSON-serialisable view of relay health for operators and
// the UI Health/Diagnostics tab.
type RelaySnapshot struct {
	Region          string              `json:"region"`
	Placed          bool                `json:"placed"`
	UptimeSeconds   float64             `json:"uptimeSeconds"`
	Transports      []TransportSnapshot `json:"transports"`
	Hop             HopSnapshot         `json:"hop"`
	RegionForwards  map[string]uint64   `json:"regionForwards"`
	OnPath          bool                `json:"onPath"`          // no off-path forwards observed
	TotalOffPath    uint64              `json:"totalOffPath"`    // across all transports
}

// HopSnapshot summarises forwarding-hop added latency.
type HopSnapshot struct {
	Samples         uint64  `json:"samples"`
	MeanNanos       uint64  `json:"meanNanos"`
	MaxNanos        uint64  `json:"maxNanos"`
	BudgetNanos     uint64  `json:"budgetNanos"`
	OverBudgetCount uint64  `json:"overBudgetCount"`
	MeanMillis      float64 `json:"meanMillis"`
	MaxMillis       float64 `json:"maxMillis"`
}

// Snapshot returns a consistent-enough read of the counters. It is OFF the hot
// path (called from an HTTP handler / operator query) and may allocate.
func (m *RelayMetrics) Snapshot() RelaySnapshot {
	if m == nil {
		return RelaySnapshot{}
	}

	snap := RelaySnapshot{
		Region:        m.region,
		Placed:        m.relayPlaced,
		UptimeSeconds: time.Since(m.startedAt).Seconds(),
		Transports:    make([]TransportSnapshot, 0, numTransports),
	}

	var totalOffPath uint64
	for t := transport(0); t < numTransports; t++ {
		tc := &m.transports[t]
		off := tc.classCount[classOffPath].Load()
		totalOffPath += off
		snap.Transports = append(snap.Transports, TransportSnapshot{
			Transport:    transportName(t),
			Packets:      tc.packets.Load(),
			Bytes:        tc.bytes.Load(),
			OnPathCount:  tc.classCount[classOnPath].Load(),
			OffPathCount: off,
			UnknownCount: tc.classCount[classUnknown].Load(),
			Drops:        tc.drops.Load(),
		})
	}

	count := m.hop.count.Load()
	sum := m.hop.sumNs.Load()
	max := m.hop.maxNs.Load()
	var meanNs uint64
	if count > 0 {
		meanNs = sum / count
	}
	budget := m.budget()
	snap.Hop = HopSnapshot{
		Samples:         count,
		MeanNanos:       meanNs,
		MaxNanos:        max,
		BudgetNanos:     budget,
		OverBudgetCount: m.hop.overBudgetCount.Load(),
		MeanMillis:      float64(meanNs) / 1e6,
		MaxMillis:       float64(max) / 1e6,
	}

	m.mu.Lock()
	snap.RegionForwards = make(map[string]uint64, len(m.regionForwards))
	for k, v := range m.regionForwards {
		snap.RegionForwards[k] = v
	}
	m.mu.Unlock()

	snap.TotalOffPath = totalOffPath
	snap.OnPath = totalOffPath == 0
	return snap
}

// ServeHTTP exposes the relay snapshot as JSON. Mount under an operator-only
// route (e.g. /metrics/relay). This is the wiring the UI Health tab consumes;
// it is intentionally read-only and off the hot path.
func (m *RelayMetrics) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(m.Snapshot())
}
