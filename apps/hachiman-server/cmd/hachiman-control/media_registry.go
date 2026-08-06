// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"mumble.info/grumble/pkg/management"
	"mumble.info/grumble/pkg/mediaproto"
	"mumble.info/grumble/pkg/oracleclient"
)

// Phase 1 step 5 — MediaControl sidechannel skeleton, control side.
//
// This file owns:
//   - the in-memory media-node registry,
//   - the MediaControl gRPC server impl (Sidechannel bidi stream),
//   - the eviction sweeper that drops nodes after 3 missed heartbeats.
//
// The full sidechannel surface lives in pkg/mediaproto/MediaControl.proto; this
// skeleton handles RegisterNode + Heartbeat only. Other envelope payloads are
// logged and ignored for now. Subsequent passes layer in OpenRoom / SDP / etc.
//
// Placement decisions are NOT served from this registry — Oracle owns placement
// per the MEDIA-PLANE-MIGRATION.md "Oracle-owns-placement" decision. This
// registry is the local liveness book-keeping control needs to make routing
// calls and reject stale or expired nodes.

const (
	// mediaHeartbeatCadence is the expected cadence reported by hachiman-media.
	// Mirrored here so the eviction window is derived from a single constant.
	mediaHeartbeatCadence = 10 * time.Second

	// mediaHeartbeatTimeout is the window after which a missing heartbeat
	// counts as a dead node — 3 missed beats per the phase-3 "On 3 missed
	// heartbeats, control evicts" line in MEDIA-PLANE-MIGRATION.md.
	mediaHeartbeatTimeout = 3 * mediaHeartbeatCadence

	// mediaEvictSweepInterval controls how often the sweeper goroutine wakes
	// to evict stale nodes. Faster than the timeout so a node ages out within
	// ~1s of crossing the threshold.
	mediaEvictSweepInterval = 5 * time.Second
)

// mediaNode captures the live state control tracks per registered media node.
// Fields are populated by RegisterNode and refreshed on each Heartbeat.
type mediaNode struct {
	nodeID          string
	region          string
	sidechannelAddr string
	version         string
	maxSessions     uint32

	// streamUUID is a per-stream identifier minted at register() time. It
	// guards against a duplicate-node_id race (follow-up #7): if a node
	// reconnects with the same node_id while the previous stream's deferred
	// evict is still pending, register() overwrites the entry with a NEW
	// streamUUID; the old stream's evict callback only deletes the entry if
	// its UUID still matches. Otherwise the new stream's entry survives.
	streamUUID string

	// Last-known heartbeat counters; zeroed on registration, overwritten on
	// each Heartbeat envelope.
	activeSessions uint32
	activeRooms    uint32
	cpuFraction    float32
	memoryFraction float32
	accepting      bool

	// Wall-clock time of the most recent successfully-processed envelope from
	// this node (register OR heartbeat). The sweeper reads this to evict.
	lastHeartbeatAt time.Time

	// registeredAt is set once on RegisterNode and never updated; used for ops
	// visibility (uptime calc).
	registeredAt time.Time

	// sendEnvelope, if non-nil, pushes an outbound envelope onto this node's
	// stream. Phase 1 final pass: control writes OpenSession / CloseSession /
	// SdpSignal / IceCandidateSignal envelopes here. Calls are safe for
	// concurrent use from non-stream goroutines (the gRPC stream's Send
	// underlying lock serializes). Nil only on a freshly-registered node
	// before the stream handler has wired it up.
	sendEnvelope func(*mediaproto.Envelope) error
}

// mediaNodeRegistry is the in-memory book of currently-live media nodes. Safe
// for concurrent use; the gRPC server impl and the sweeper goroutine both touch
// it. Lookups for placement live here once placement work lands; for now the
// registry is consulted only by tests + ops introspection.
type mediaNodeRegistry struct {
	mu    sync.RWMutex
	nodes map[string]*mediaNode

	// now is a hook for tests to inject a deterministic clock. Production uses
	// time.Now.
	now func() time.Time

	// timeout is the inactivity window after which the sweeper evicts a node.
	// Held as a field (not a const) so tests can shorten it without waiting
	// 30s real time.
	timeout time.Duration
}

func newMediaNodeRegistry() *mediaNodeRegistry {
	return &mediaNodeRegistry{
		nodes:   make(map[string]*mediaNode),
		now:     time.Now,
		timeout: mediaHeartbeatTimeout,
	}
}

// register records a freshly-registered node. Overwrites any existing record
// for the same node_id — a reconnect after partition replays the same UUID and
// the existing entry is treated as stale. Returns the per-stream UUID minted
// for this registration so the caller can scope its deferred evict() against
// the same UUID (follow-up #7).
func (r *mediaNodeRegistry) register(payload *mediaproto.RegisterNode, send func(*mediaproto.Envelope) error) string {
	if payload == nil || payload.GetNodeId() == "" {
		return ""
	}
	streamUUID := uuid.NewString()
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.nodes[payload.GetNodeId()] = &mediaNode{
		nodeID:          payload.GetNodeId(),
		region:          payload.GetRegion(),
		sidechannelAddr: payload.GetSidechannelAddr(),
		version:         payload.GetVersion(),
		maxSessions:     payload.GetMaxSessions(),
		streamUUID:      streamUUID,
		sendEnvelope:    send,
		accepting:       true,
		registeredAt:    now,
		lastHeartbeatAt: now,
	}
	return streamUUID
}

// heartbeat refreshes the live metrics on an existing entry. A heartbeat for an
// unknown node is dropped — the corresponding stream MUST have started with a
// RegisterNode (enforced at the gRPC layer) so this should never fire in
// practice; the no-op is a defence-in-depth guard against races.
func (r *mediaNodeRegistry) heartbeat(nodeID string, payload *mediaproto.Heartbeat) {
	if nodeID == "" || payload == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	node, ok := r.nodes[nodeID]
	if !ok {
		return
	}
	node.activeSessions = payload.GetActiveSessions()
	node.activeRooms = payload.GetActiveRooms()
	node.cpuFraction = payload.GetCpuFraction()
	node.memoryFraction = payload.GetMemoryFraction()
	node.accepting = payload.GetAccepting()
	node.lastHeartbeatAt = r.now()
}

// evict removes a node from the registry. Idempotent. The sweeper calls this
// when a node ages out — it doesn't carry a streamUUID because the eviction is
// time-based, not stream-bound.
func (r *mediaNodeRegistry) evict(nodeID string) {
	if nodeID == "" {
		return
	}
	r.mu.Lock()
	delete(r.nodes, nodeID)
	r.mu.Unlock()
}

// evictIfStream removes the registry entry for nodeID ONLY if its current
// streamUUID matches the supplied one. This is the safe form to call from a
// stream handler's deferred cleanup: if the same node_id reconnected on a new
// stream while the old one was unwinding, the entry's streamUUID has rolled to
// the new stream's value and the old defer is a no-op. Returns true if an
// eviction happened, false if the entry was already gone or belonged to a
// newer stream (follow-up #7).
func (r *mediaNodeRegistry) evictIfStream(nodeID, streamUUID string) bool {
	if nodeID == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	node, ok := r.nodes[nodeID]
	if !ok {
		return false
	}
	if node.streamUUID != streamUUID {
		return false
	}
	delete(r.nodes, nodeID)
	return true
}

// get returns a snapshot copy of the registry entry for nodeID, or nil if not
// present. The copy isolates callers from concurrent mutation under the lock.
func (r *mediaNodeRegistry) get(nodeID string) *mediaNode {
	r.mu.RLock()
	defer r.mu.RUnlock()
	node, ok := r.nodes[nodeID]
	if !ok {
		return nil
	}
	out := *node
	return &out
}

// size returns the current live node count. Useful for tests and metrics.
func (r *mediaNodeRegistry) size() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.nodes)
}

// pickNode picks a media node to assign a new session to. Phase 1 is "any
// accepting registered node" — Oracle's full placement scorer is phase 3+,
// and per the migration doc step 6/7 placement decisions WILL move to Oracle.
// For now: pick the first accepting node in stable map-iteration order to
// keep tests deterministic across small registries; returns "" if none.
//
// errNoMediaNode is the sentinel for "no accepting node registered". Callers
// that want to surface a clean "WebRTC unavailable" path to the client treat
// this distinctly from any other dispatch error.
func (r *mediaNodeRegistry) pickNode() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	// Stable iteration: ranging a map is unordered in general, but for a single
	// node (the steady state in phase 1 dev / embedded) the result is fixed.
	// When the multi-node path lands we'll plumb a real scorer through; the
	// signature already returns a string node id, so the caller doesn't change.
	for id, node := range r.nodes {
		if node.accepting {
			return id
		}
	}
	return ""
}

// sendTo dispatches env to the node identified by nodeID. Returns
// errNoMediaNode if the node isn't in the registry, or errSendNotWired if the
// node's stream handler hasn't attached a send func yet (very brief window
// between RegisterNode arriving and the stream loop kicking in). Errors from
// the underlying gRPC Send (network / context-cancelled) propagate.
func (r *mediaNodeRegistry) sendTo(nodeID string, env *mediaproto.Envelope) error {
	r.mu.RLock()
	node, ok := r.nodes[nodeID]
	if !ok {
		r.mu.RUnlock()
		return errNoMediaNode
	}
	send := node.sendEnvelope
	r.mu.RUnlock()
	if send == nil {
		return errSendNotWired
	}
	return send(env)
}

// errNoMediaNode is returned when control needs to dispatch to a media node
// but the registry has none registered (or the named one isn't there). The
// caller treats this as "WebRTC unavailable" — log + keep the Mumble session
// alive for text chat.
var errNoMediaNode = errors.New("media-registry: no media node available")

// errSendNotWired is returned when a node has registered but its stream
// handler hasn't yet wired up the outbound send func. Tiny window; callers
// should retry or treat the same as errNoMediaNode.
var errSendNotWired = errors.New("media-registry: send func not wired yet")

// sweepOnce evicts any node whose lastHeartbeatAt is older than timeout
// relative to the registry's clock. Returns the set of evicted node IDs for
// logging.
func (r *mediaNodeRegistry) sweepOnce() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	var evicted []string
	for id, node := range r.nodes {
		if now.Sub(node.lastHeartbeatAt) > r.timeout {
			delete(r.nodes, id)
			evicted = append(evicted, id)
		}
	}
	return evicted
}

// runSweeper runs the eviction sweep on a ticker until ctx is cancelled.
// Intended to run in its own goroutine for the lifetime of the gRPC server.
// If done is non-nil it is closed when the sweeper exits — callers (notably
// Stop()/tests) use this to assert clean teardown.
//
// HIGH #2: when the sweeper evicts a node, dispatcher.NodeEvicted is fired
// so the per-vServer client maps can clear their bookkeeping. nil dispatcher
// (headless / test mode) skips the hook.
func (r *mediaNodeRegistry) runSweeper(ctx context.Context, interval time.Duration, logger *log.Logger, dispatcher mediaInboundDispatcher, done chan<- struct{}) {
	if done != nil {
		defer close(done)
	}
	if interval <= 0 {
		interval = mediaEvictSweepInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			evicted := r.sweepOnce()
			if len(evicted) == 0 {
				continue
			}
			for _, id := range evicted {
				if logger != nil {
					logger.Printf("[media-registry] evicted node %s (missed >%s)", id, r.timeout)
				}
				if dispatcher != nil {
					dispatcher.NodeEvicted(id)
				}
			}
		}
	}
}

// mediaSidechannelServer implements mediaproto.MediaControlServer for the
// control plane side of the sidechannel. Each Sidechannel RPC corresponds to
// one media node; the first envelope MUST be RegisterNode.
//
// The dispatcher is the hook into the rest of the control plane — it knows how
// to translate `SdpSignal` / `IceCandidateSignal` / `SessionEstablished` /
// `SessionEnded` envelopes into client-side state changes (typically a Mumble
// `WebRTC` / `IceCandidate` packet to the client). Nil dispatcher = headless
// mode (tests only; production wires Server through newMediaSidechannelServer).
type mediaSidechannelServer struct {
	mediaproto.UnimplementedMediaControlServer

	registry   *mediaNodeRegistry
	logger     *log.Logger
	dispatcher mediaInboundDispatcher
	// oracle is best-effort mirror sink: when set, RegisterNode and
	// Heartbeat envelopes ALSO call the matching Oracle RPC so Oracle's
	// media_nodes table reflects the live fleet. Nil disables mirroring
	// (the local registry stays authoritative); errors are logged and
	// dropped to keep the sidechannel resilient to Oracle blips.
	oracle oracleClient
}

// mediaInboundDispatcher is the interface exposed by control's *Server (and a
// mock in tests) for receiving inbound envelopes from media. Routing of which
// session belongs to which vServer is the server's problem; the dispatcher's
// job is to translate envelopes into per-client effects.
type mediaInboundDispatcher interface {
	// HandleMediaInbound is called once per inbound envelope from media. The
	// envelope is already known to be a payload type that needs server-state
	// action (SdpSignal / IceCandidateSignal / SessionEstablished /
	// SessionEnded). Registry-housekeeping envelopes (Heartbeat / Ack /
	// StreamError / RegisterNode) are handled inline by the sidechannel
	// server before reaching the dispatcher.
	HandleMediaInbound(nodeID string, env *mediaproto.Envelope)

	// NodeEvicted is fired exactly once per media-node lifecycle when the
	// sidechannel stream closes (stream EOF) or the sweeper times the node
	// out. HIGH #2: the dispatcher walks its client maps and clears every
	// client bound to that node so they don't keep believing they have a
	// live SFU peer. Phase 1: cleanup-only — phase 3 cascade work will
	// re-place sessions on a healthy node.
	NodeEvicted(nodeID string)
}

func newMediaSidechannelServer(registry *mediaNodeRegistry, logger *log.Logger, dispatcher mediaInboundDispatcher) *mediaSidechannelServer {
	return &mediaSidechannelServer{
		registry:   registry,
		logger:     logger,
		dispatcher: dispatcher,
	}
}

// withOracle returns a copy of the sidechannel server wired to mirror
// RegisterNode + Heartbeat envelopes to Oracle. Nil oc leaves mirroring off.
// Used at construction time in listenMediaSidechannel; exposed as a separate
// hook so tests can drop in a fake.
func (s *mediaSidechannelServer) withOracle(oc oracleClient) *mediaSidechannelServer {
	cpy := *s
	cpy.oracle = oc
	return &cpy
}

// firstRecvDeadline bounds how long the server waits for the first envelope on
// a freshly-opened sidechannel stream. A misbehaving client opening the stream
// and then never sending RegisterNode would otherwise leak a goroutine until OS
// TCP keepalive (minutes-to-hours). 5s is comfortably above any normal RTT +
// handshake delay.
const firstRecvDeadline = 5 * time.Second

// Sidechannel handles one node's bidi stream. The contract is:
//
//   - First inbound envelope MUST carry payload=RegisterNode; anything else is
//     a protocol violation and the RPC is failed with FailedPrecondition. The
//     first Recv has a firstRecvDeadline timeout so a stuck client can't leak
//     a goroutine.
//   - Subsequent envelopes are dispatched; Heartbeat refreshes the registry
//     entry. Unrecognised payloads are logged and ignored (forward-compat).
//   - On EOF / context cancel the node is evicted from the registry (but ONLY
//     if the registry entry still belongs to THIS stream — guards against a
//     reconnect race; see evictIfStream).
func (s *mediaSidechannelServer) Sidechannel(stream grpc.BidiStreamingServer[mediaproto.Envelope, mediaproto.Envelope]) error {
	first, err := recvFirstWithDeadline(stream, firstRecvDeadline)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return status.Error(codes.FailedPrecondition, "sidechannel closed before RegisterNode")
		}
		return err
	}
	reg := first.GetRegisterNode()
	if reg == nil {
		return status.Error(codes.FailedPrecondition, "first sidechannel envelope must be RegisterNode")
	}
	if reg.GetNodeId() == "" {
		return status.Error(codes.FailedPrecondition, "RegisterNode.node_id must not be empty")
	}

	nodeID := reg.GetNodeId()

	// Wrap stream.Send with a mutex — gRPC streams are not safe for
	// concurrent Sends. The sender comes from multiple goroutines: the
	// client-disconnect path (CloseSession), the per-client WebRTC handler
	// (SdpSignal), and the trickle-ICE path (IceCandidateSignal). Without
	// the lock those interleave and the framing breaks.
	var sendMu sync.Mutex
	send := func(env *mediaproto.Envelope) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(env)
	}

	streamUUID := s.registry.register(reg, send)
	if s.logger != nil {
		s.logger.Printf("[media-registry] registered node %s region=%q sidechannel=%q max_sessions=%d version=%q stream=%s",
			nodeID, reg.GetRegion(), reg.GetSidechannelAddr(), reg.GetMaxSessions(), reg.GetVersion(), streamUUID)
	}
	streamCtx := stream.Context()
	// Best-effort mirror to Oracle so its media_nodes table reflects the
	// fleet. Errors (oracle unreachable, ErrUnconfigured) log and drop —
	// the local registry stays authoritative for dispatch, and the next
	// heartbeat will re-attempt. Once-per-stream — synchronous is fine.
	s.mirrorRegisterNode(streamCtx, reg)
	// Per-stream heartbeat coalescer. Dispatches mirror calls on a single
	// background goroutine; new heartbeats arriving while a mirror call is
	// in flight replace the pending payload (drop-and-replace, not queue).
	// Keeps the recv loop responsive when Oracle is slow — see HIGH #2 in
	// the phase 3a fix-pass.
	hbMirror := newHeartbeatMirror(streamCtx, nodeID, s)
	defer hbMirror.close()
	defer func() {
		if s.registry.evictIfStream(nodeID, streamUUID) {
			if s.logger != nil {
				s.logger.Printf("[media-registry] node %s sidechannel closed; evicted (stream=%s)", nodeID, streamUUID)
			}
			// HIGH #2: notify the dispatcher so it can walk its client
			// maps and clear every session bound to this node. Without
			// this, voice stays permanently dead on those clients until
			// they reconnect.
			if s.dispatcher != nil {
				s.dispatcher.NodeEvicted(nodeID)
			}
		} else if s.logger != nil {
			s.logger.Printf("[media-registry] node %s sidechannel closed; entry already replaced or evicted (stream=%s)", nodeID, streamUUID)
		}
	}()

	for {
		env, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		s.dispatch(nodeID, env, hbMirror)
	}
}

// dispatch routes a single envelope to the appropriate registry mutation or
// to the server-side dispatcher. Registry-housekeeping envelopes (Heartbeat,
// duplicate RegisterNode) are absorbed here; SdpSignal / IceCandidateSignal /
// SessionEstablished / SessionEnded are forwarded to the dispatcher (typically
// the control Server) which translates them into client-side state changes.
//
// Phase 1 still leaves the recording / cascading payloads as log-and-ignore —
// those land with phase 2/3 runtime.
//
// hbMirror is the per-stream singleflight-style coalescer for Oracle mirror
// calls; nil disables mirroring (tests that don't wire Oracle).
func (s *mediaSidechannelServer) dispatch(nodeID string, env *mediaproto.Envelope, hbMirror *heartbeatMirror) {
	switch payload := env.GetPayload().(type) {
	case *mediaproto.Envelope_Heartbeat:
		s.registry.heartbeat(nodeID, payload.Heartbeat)
		// Best-effort Oracle mirror — keep its last_heartbeat_at fresh
		// so placement sees the node as alive. Coalesced via the per-
		// stream heartbeatMirror so a laggy Oracle (~oracleMirrorTimeout)
		// can't slow the recv loop below the 10s heartbeat cadence.
		if hbMirror != nil {
			hbMirror.submit(payload.Heartbeat)
		}
	case *mediaproto.Envelope_RegisterNode:
		// A second RegisterNode on the same stream is a protocol bug on the
		// media side. Log and ignore — refusing the rest of the stream would
		// cause spurious node loss.
		if s.logger != nil {
			s.logger.Printf("[media-registry] node %s sent unexpected RegisterNode mid-stream; ignoring", nodeID)
		}
	case *mediaproto.Envelope_SdpSignal,
		*mediaproto.Envelope_IceCandidateSignal,
		*mediaproto.Envelope_SessionEstablished,
		*mediaproto.Envelope_SessionEnded:
		if s.dispatcher != nil {
			s.dispatcher.HandleMediaInbound(nodeID, env)
		} else if s.logger != nil {
			s.logger.Printf("[media-registry] node %s sent dispatchable envelope %T but no dispatcher wired",
				nodeID, env.GetPayload())
		}
	case *mediaproto.Envelope_Ack, *mediaproto.Envelope_Error:
		// Housekeeping; phase 1 doesn't act on these.
	default:
		if s.logger != nil && env.GetPayload() != nil {
			s.logger.Printf("[media-registry] node %s sent envelope payload type %T (ignored in phase 1)",
				nodeID, env.GetPayload())
		}
	}
}

// mirrorRegisterNode forwards RegisterNode to Oracle best-effort. Bounded by
// a short context timeout so a wedged Oracle never blocks the sidechannel
// handler. Errors log and drop — the local registry is the dispatch source
// of truth; Oracle's role is placement, and a single missed register is
// caught by the next heartbeat's mirror.
func (s *mediaSidechannelServer) mirrorRegisterNode(streamCtx context.Context, reg *mediaproto.RegisterNode) {
	if s.oracle == nil || reg == nil {
		return
	}
	ctx, cancel := context.WithTimeout(streamCtx, oracleMirrorTimeout)
	defer cancel()
	req := &management.RegisterMediaNodeRequest{
		NodeId:          reg.GetNodeId(),
		Region:          reg.GetRegion(),
		SidechannelAddr: reg.GetSidechannelAddr(),
		MaxSessions:     reg.GetMaxSessions(),
		Version:         reg.GetVersion(),
	}
	if _, err := s.oracle.RegisterMediaNode(ctx, req); err != nil {
		if errors.Is(err, oracleclient.ErrUnconfigured) {
			return
		}
		if s.logger != nil {
			s.logger.Printf("[oracle-mirror] RegisterMediaNode for %s failed: %v", reg.GetNodeId(), err)
		}
	}
}

// mirrorHeartbeat forwards Heartbeat to Oracle best-effort with the same
// timeout + drop-on-error posture as mirrorRegisterNode. Parent ctx is the
// per-stream Context — cancelling the stream cleanly aborts any in-flight
// mirror call (matches mirrorRegisterNode; previously this used
// context.Background() which leaked an in-flight call past stream close).
func (s *mediaSidechannelServer) mirrorHeartbeat(parent context.Context, nodeID string, hb *mediaproto.Heartbeat) {
	if s.oracle == nil || hb == nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, oracleMirrorTimeout)
	defer cancel()
	req := &management.MediaNodeHeartbeatRequest{
		NodeId:         nodeID,
		ActiveSessions: hb.GetActiveSessions(),
		CpuFraction:    hb.GetCpuFraction(),
		Accepting:      hb.GetAccepting(),
	}
	if _, err := s.oracle.MediaNodeHeartbeat(ctx, req); err != nil {
		if errors.Is(err, oracleclient.ErrUnconfigured) {
			return
		}
		if s.logger != nil {
			s.logger.Printf("[oracle-mirror] MediaNodeHeartbeat for %s failed: %v", nodeID, err)
		}
	}
}

// oracleMirrorTimeout bounds how long an Oracle mirror call may take. Short
// enough that a wedged Oracle doesn't back up the sidechannel; long enough
// to absorb normal network jitter on the cross-VPC call. 2s matches the
// session-establishment p95 SLO so a stalled Oracle still surfaces as a
// timeout within the per-session budget.
const oracleMirrorTimeout = 2 * time.Second

// heartbeatMirror coalesces best-effort Oracle MediaNodeHeartbeat calls per
// sidechannel stream. submit() never blocks the caller (the recv loop) — it
// hands the latest heartbeat to a worker goroutine via a single-slot mailbox.
// If the worker is mid-call when a new heartbeat arrives, the previous
// pending heartbeat (if any) is overwritten — "drop and replace", not
// "queue". Oracle only cares about freshness; old in-flight + a new pending
// payload would just bill us for a redundant call.
//
// Lifecycle:
//   - newHeartbeatMirror starts the worker goroutine with the stream's
//     Context so stream cancellation kills any in-flight Oracle call.
//   - submit() is goroutine-safe but only ever called from the recv loop
//     today (single-producer). Multi-producer is fine too.
//   - close() stops the worker. Safe to call multiple times (idempotent on
//     a sync.Once).
//
// Background context choice: we cancel via streamCtx, so the worker exits
// when the stream ends. Errors from in-flight Oracle calls during shutdown
// surface as context.Canceled which mirrorHeartbeat already handles
// gracefully.
type heartbeatMirror struct {
	server *mediaSidechannelServer
	nodeID string
	ctx    context.Context
	cancel context.CancelFunc

	// pending holds the latest heartbeat awaiting a mirror call. Guarded
	// by mu. wake signals the worker that pending has new content.
	mu      sync.Mutex
	pending *mediaproto.Heartbeat
	wake    chan struct{}

	closeOnce sync.Once
	done      chan struct{}
}

// newHeartbeatMirror starts a coalescing mirror worker tied to streamCtx.
// Returns a usable mirror even when server.oracle is nil — submit() is a
// no-op in that case, keeping the dispatch path branch-free.
func newHeartbeatMirror(streamCtx context.Context, nodeID string, server *mediaSidechannelServer) *heartbeatMirror {
	ctx, cancel := context.WithCancel(streamCtx)
	m := &heartbeatMirror{
		server: server,
		nodeID: nodeID,
		ctx:    ctx,
		cancel: cancel,
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
	go m.loop()
	return m
}

// submit hands the latest heartbeat off to the worker. Non-blocking; if a
// previous heartbeat hasn't been picked up yet it gets overwritten (drop
// and replace).
func (m *heartbeatMirror) submit(hb *mediaproto.Heartbeat) {
	if m == nil || m.server.oracle == nil || hb == nil {
		return
	}
	m.mu.Lock()
	m.pending = hb
	m.mu.Unlock()
	// Non-blocking wake; if a wake is already queued the worker will see
	// the latest pending when it picks up.
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *heartbeatMirror) loop() {
	defer close(m.done)
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.wake:
			m.mu.Lock()
			hb := m.pending
			m.pending = nil
			m.mu.Unlock()
			if hb == nil {
				continue
			}
			m.server.mirrorHeartbeat(m.ctx, m.nodeID, hb)
		}
	}
}

// close stops the worker. Returns once the loop has exited so callers can
// rely on no further Oracle calls being made on behalf of this stream.
func (m *heartbeatMirror) close() {
	if m == nil {
		return
	}
	m.closeOnce.Do(func() {
		m.cancel()
	})
	<-m.done
}

// recvFirstWithDeadline wraps the first stream.Recv() with a wall-clock timeout
// so a client that opens the stream and never sends anything can't leak the
// handler goroutine. gRPC's Recv() doesn't take a context directly, so we run
// it on a goroutine and race a timer against it. On timeout we return a
// DeadlineExceeded status — the client's stream RPC then fails cleanly and the
// handler unwinds.
//
// The blocked Recv goroutine survives until the underlying stream is torn down
// by the deferred return of the RPC, which is fine: it costs one goroutine for
// at most the remainder of the connection's TCP keepalive window, and the
// alternative (no deadline) made that the steady-state behaviour for every
// misbehaving client.
func recvFirstWithDeadline(stream grpc.BidiStreamingServer[mediaproto.Envelope, mediaproto.Envelope], d time.Duration) (*mediaproto.Envelope, error) {
	type result struct {
		env *mediaproto.Envelope
		err error
	}
	ch := make(chan result, 1)
	go func() {
		env, err := stream.Recv()
		ch <- result{env: env, err: err}
	}()
	select {
	case r := <-ch:
		return r.env, r.err
	case <-time.After(d):
		return nil, status.Errorf(codes.DeadlineExceeded,
			"first sidechannel envelope not received within %s", d)
	case <-stream.Context().Done():
		return nil, stream.Context().Err()
	}
}

// mediaSidechannelListener bundles the gRPC server, its bound listener, and the
// registry + sweeper goroutine so the boot path can manage them as one unit.
type mediaSidechannelListener struct {
	addr     string
	lis      net.Listener
	server   *grpc.Server
	registry *mediaNodeRegistry
	cancel   context.CancelFunc

	// sweeperDone is closed once the sweeper goroutine has returned. Tests use
	// it to assert clean shutdown; production code can ignore it.
	sweeperDone chan struct{}
}

// Addr returns the bound address (useful for tests using a :0 port).
func (l *mediaSidechannelListener) Addr() string {
	if l.lis == nil {
		return l.addr
	}
	return l.lis.Addr().String()
}

// Serve blocks running the gRPC server until Stop is called. On ANY exit
// (graceful or error) the sweeper context is cancelled so its goroutine
// unwinds — otherwise a listener-level failure would leak the sweeper.
func (l *mediaSidechannelListener) Serve() error {
	defer l.cancel()
	return l.server.Serve(l.lis)
}

// Stop gracefully shuts down the gRPC server and stops the sweeper. Blocks
// until the sweeper goroutine has returned so callers (notably tests) can
// assert clean teardown without racing.
func (l *mediaSidechannelListener) Stop() {
	if l.cancel != nil {
		l.cancel()
	}
	if l.server != nil {
		l.server.GracefulStop()
	}
	if l.sweeperDone != nil {
		<-l.sweeperDone
	}
}

// SweeperDone returns a channel that is closed once the sweeper goroutine has
// exited. Exposed for tests; production callers can use Stop() which already
// awaits it internally.
func (l *mediaSidechannelListener) SweeperDone() <-chan struct{} {
	return l.sweeperDone
}

// Registry returns the underlying registry — exposed so callers (currently
// tests, future placement code) can inspect node state.
func (l *mediaSidechannelListener) Registry() *mediaNodeRegistry {
	return l.registry
}

// listenMediaSidechannel binds the MediaControl gRPC server on addr and starts
// the eviction sweeper. addr must be a non-empty host:port; the host is
// validated to be loopback because phase 1 ships without mTLS — non-loopback
// binds would expose the registry to the network. Deploys add mTLS via a later
// follow-up before lifting this constraint.
//
// dispatcher (typically the inboundDispatcher registered on the control vServer
// registry) receives SdpSignal / IceCandidateSignal / SessionEstablished /
// SessionEnded envelopes for translation to per-client wire effects. Nil
// dispatcher = inbound dispatchable envelopes get logged and dropped, which is
// fine for unit tests that only exercise registry housekeeping.
func listenMediaSidechannel(addr string, logger *log.Logger, dispatcher mediaInboundDispatcher, oracle oracleClient) (*mediaSidechannelListener, error) {
	if addr == "" {
		return nil, errors.New("media sidechannel: addr must not be empty")
	}
	if err := requireLoopbackForMedia(addr); err != nil {
		return nil, err
	}

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("media sidechannel: listen %q: %w", addr, err)
	}

	registry := newMediaNodeRegistry()
	gs := grpc.NewServer()
	srv := newMediaSidechannelServer(registry, logger, dispatcher).withOracle(oracle)
	mediaproto.RegisterMediaControlServer(gs, srv)

	ctx, cancel := context.WithCancel(context.Background())
	sweeperDone := make(chan struct{})
	go registry.runSweeper(ctx, mediaEvictSweepInterval, logger, dispatcher, sweeperDone)

	return &mediaSidechannelListener{
		addr:        addr,
		lis:         lis,
		server:      gs,
		registry:    registry,
		cancel:      cancel,
		sweeperDone: sweeperDone,
	}, nil
}

// requireLoopbackForMedia mirrors the management package's same-named guard
// without depending on it (the management package owns its own posture and
// shouldn't grow incidental exports for cross-package reuse this early).
func requireLoopbackForMedia(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("media sidechannel: invalid addr %q: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("media sidechannel: addr %q omits host — refusing to bind to all interfaces "+
			"(phase 1 has no mTLS, loopback only)", addr)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("media sidechannel: host %q is not an IP and not 'localhost' — refusing "+
			"(phase 1 has no mTLS, loopback only)", host)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("media sidechannel: host %q is not loopback — refusing to bind "+
			"(phase 1 has no mTLS, loopback only)", host)
	}
	return nil
}
