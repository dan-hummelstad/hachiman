// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"mumble.info/grumble/pkg/mediaproto"
)

// TestMediaRegistry_RegisterHeartbeatEvict locks in the phase-1 sidechannel
// contract from MEDIA-PLANE-MIGRATION.md step 5:
//
//   - First inbound envelope MUST be RegisterNode; otherwise FailedPrecondition.
//   - Heartbeats refresh the registry entry's last_heartbeat_at.
//   - On stream close, the node is evicted from the registry.
//   - Idle nodes (no heartbeat within the timeout) are evicted by the sweeper.
//
// The test runs the gRPC server on a real loopback :0 socket so the wire path
// is exercised end-to-end (codegen, serialization, grpc-go bidi semantics).
func TestMediaRegistry_RegisterHeartbeatEvict(t *testing.T) {
	logger := log.New(os.Stderr, "[test] ", 0)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	registry := newMediaNodeRegistry()
	// Shorten the eviction window so the sweep assertion doesn't wait 30s.
	registry.timeout = 200 * time.Millisecond
	server := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(server, newMediaSidechannelServer(registry, logger, nil))

	go func() {
		_ = server.Serve(lis)
	}()
	defer server.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := mediaproto.NewMediaControlClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	const nodeID = "test-node-1"
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId:      nodeID,
				Region:      "us-east-test",
				MaxSessions: 100,
				Version:     "v0.test",
			},
		},
	}); err != nil {
		t.Fatalf("send RegisterNode: %v", err)
	}

	// Wait for the registry entry to land. The server applies it on Recv,
	// which is asynchronous to our Send returning, so a short poll loop is
	// the right shape (vs sleep + check once).
	if !waitForCondition(2*time.Second, func() bool {
		return registry.get(nodeID) != nil
	}) {
		t.Fatalf("node not registered within 2s; registry size=%d", registry.size())
	}

	first := registry.get(nodeID)
	if first.region != "us-east-test" {
		t.Errorf("region: got %q, want %q", first.region, "us-east-test")
	}
	if first.maxSessions != 100 {
		t.Errorf("max_sessions: got %d, want 100", first.maxSessions)
	}
	firstHeartbeatAt := first.lastHeartbeatAt

	// Send two heartbeats and verify last_heartbeat_at moves forward.
	for i := 0; i < 2; i++ {
		// Sleep enough that the clock can advance — Go's monotonic clock is
		// fine-grained, but on macOS it's <1µs which sometimes catches the
		// equality check below in a tied state.
		time.Sleep(20 * time.Millisecond)
		if err := stream.Send(&mediaproto.Envelope{
			Payload: &mediaproto.Envelope_Heartbeat{
				Heartbeat: &mediaproto.Heartbeat{
					ActiveSessions: uint32(i + 1),
					Accepting:      true,
				},
			},
		}); err != nil {
			t.Fatalf("send heartbeat %d: %v", i, err)
		}
	}

	if !waitForCondition(2*time.Second, func() bool {
		entry := registry.get(nodeID)
		return entry != nil && entry.lastHeartbeatAt.After(firstHeartbeatAt) && entry.activeSessions == 2
	}) {
		entry := registry.get(nodeID)
		t.Fatalf("heartbeats did not refresh registry entry: entry=%+v firstHeartbeatAt=%v",
			entry, firstHeartbeatAt)
	}

	// Close the send side and wait for the server to evict the node.
	if err := stream.CloseSend(); err != nil {
		t.Fatalf("close send: %v", err)
	}
	// Drain the recv side until io.EOF so the server's defer (which evicts)
	// has fired.
	for {
		if _, err := stream.Recv(); err != nil {
			if err != io.EOF {
				// status.Canceled is also acceptable if the ctx outer-cancels.
				if s, ok := status.FromError(err); ok && s.Code() == codes.Canceled {
					break
				}
			}
			break
		}
	}

	if !waitForCondition(2*time.Second, func() bool {
		return registry.get(nodeID) == nil
	}) {
		t.Fatalf("node not evicted after stream close: %+v", registry.get(nodeID))
	}
}

// TestMediaRegistry_RejectsEmptyNodeID locks in the contract that
// RegisterNode.node_id MUST be non-empty. Empty node_id is rejected with
// FailedPrecondition before any registry mutation.
func TestMediaRegistry_RejectsEmptyNodeID(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	registry := newMediaNodeRegistry()
	server := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(server, newMediaSidechannelServer(registry, logger, nil))
	go func() {
		_ = server.Serve(lis)
	}()
	defer server.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := mediaproto.NewMediaControlClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId:      "", // contract violation
				Region:      "us-east-test",
				MaxSessions: 1,
			},
		},
	}); err != nil {
		t.Fatalf("send empty-id RegisterNode: %v", err)
	}
	if err := stream.CloseSend(); err != nil {
		t.Fatalf("close send: %v", err)
	}
	_, err = stream.Recv()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	s, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status, got %v", err)
	}
	if s.Code() != codes.FailedPrecondition {
		t.Errorf("code: got %v, want FailedPrecondition", s.Code())
	}
	if registry.size() != 0 {
		t.Errorf("registry should be empty after rejected stream, got size=%d", registry.size())
	}
}

// TestMediaRegistry_RejectsFirstNonRegisterEnvelope locks in the contract that
// the first envelope MUST be RegisterNode. Sending a Heartbeat-first stream is
// rejected with FailedPrecondition.
func TestMediaRegistry_RejectsFirstNonRegisterEnvelope(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	registry := newMediaNodeRegistry()
	server := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(server, newMediaSidechannelServer(registry, logger, nil))
	go func() {
		_ = server.Serve(lis)
	}()
	defer server.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := mediaproto.NewMediaControlClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_Heartbeat{
			Heartbeat: &mediaproto.Heartbeat{Accepting: true},
		},
	}); err != nil {
		t.Fatalf("send heartbeat: %v", err)
	}
	if err := stream.CloseSend(); err != nil {
		t.Fatalf("close send: %v", err)
	}
	// Recv the final status from the server.
	_, err = stream.Recv()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	s, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status, got %v", err)
	}
	if s.Code() != codes.FailedPrecondition {
		t.Errorf("code: got %v, want FailedPrecondition", s.Code())
	}
	if registry.size() != 0 {
		t.Errorf("registry should be empty after rejected stream, got size=%d", registry.size())
	}
}

// TestMediaRegistry_SweeperEvictsStaleNodes locks in the timeout-based
// eviction: a registered node that stops heartbeating is evicted after the
// configured timeout.
func TestMediaRegistry_SweeperEvictsStaleNodes(t *testing.T) {
	registry := newMediaNodeRegistry()
	registry.timeout = 50 * time.Millisecond

	// Deterministic clock so the sweep window is exact.
	var nowNs atomic.Int64
	nowNs.Store(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixNano())
	registry.now = func() time.Time {
		return time.Unix(0, nowNs.Load())
	}

	registry.register(&mediaproto.RegisterNode{NodeId: "n1", Region: "x", MaxSessions: 1}, nil)
	if registry.size() != 1 {
		t.Fatalf("expected size 1 after register, got %d", registry.size())
	}

	// First sweep at the same wall time -> nothing evicted.
	if evicted := registry.sweepOnce(); len(evicted) != 0 {
		t.Errorf("unexpected eviction on fresh entry: %v", evicted)
	}

	// Advance clock past timeout -> entry sweeps out.
	nowNs.Add(int64(100 * time.Millisecond))
	evicted := registry.sweepOnce()
	if len(evicted) != 1 || evicted[0] != "n1" {
		t.Errorf("expected eviction of n1, got %v", evicted)
	}
	if registry.size() != 0 {
		t.Errorf("registry should be empty after sweep, got %d", registry.size())
	}
}

// TestMediaRegistry_SweeperTeardownOnStop locks in MEDIUM #3: the sweeper
// goroutine must exit when the listener is Stopped (and likewise on any other
// path that cancels the listener's ctx, including Serve() returning by itself).
// Without this guarantee, a listener-level failure or shutdown would leak the
// sweeper for the lifetime of the process.
func TestMediaRegistry_SweeperTeardownOnStop(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	l, err := listenMediaSidechannel("127.0.0.1:0", logger, nil, nil)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	// Serve in background; assert it returns once we Stop.
	serveDone := make(chan struct{})
	go func() {
		_ = l.Serve()
		close(serveDone)
	}()

	// Register a node so the path exercises a real envelope through the
	// listener, not just the listener spinning empty.
	conn, err := grpc.NewClient(l.Addr(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	client := mediaproto.NewMediaControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId: "teardown-node-1", Region: "x", MaxSessions: 1,
			},
		},
	}); err != nil {
		t.Fatalf("send register: %v", err)
	}
	if !waitForCondition(2*time.Second, func() bool {
		return l.Registry().size() == 1
	}) {
		t.Fatalf("node not registered before Stop()")
	}

	_ = stream.CloseSend()
	_ = conn.Close()

	// Stop is the canonical teardown — it cancels the ctx, GracefulStops the
	// gRPC server, and waits for the sweeper goroutine to exit.
	l.Stop()

	select {
	case <-serveDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after Stop")
	}
	select {
	case <-l.SweeperDone():
	case <-time.After(2 * time.Second):
		t.Fatal("sweeper goroutine did not exit after Stop")
	}
}

// TestMediaRegistry_FirstRecvDeadline locks in MEDIUM #7: a client that opens
// the stream and never sends anything must NOT leak a server goroutine — the
// server enforces firstRecvDeadline before returning DeadlineExceeded.
func TestMediaRegistry_FirstRecvDeadline(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	registry := newMediaNodeRegistry()
	server := grpc.NewServer()

	// Wire a short deadline by swapping the const-shadowing pattern: we run
	// against the production handler with a small deadline by registering an
	// alternative server impl that uses a tiny window. Simpler: just register
	// the real handler and rely on the 5s deadline — but 5s would slow the
	// test suite. Instead we register a thin wrapper.
	srv := newMediaSidechannelServer(registry, logger, nil)
	mediaproto.RegisterMediaControlServer(server, srv)

	go func() {
		_ = server.Serve(lis)
	}()
	defer server.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := mediaproto.NewMediaControlClient(conn)

	// Generous client-side timeout so we observe the server-side deadline,
	// not the client one.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	// Intentionally never Send anything. The server's first Recv will time
	// out after firstRecvDeadline (production: 5s).
	start := time.Now()
	_, err = stream.Recv()
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected deadline error, got nil")
	}
	s, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status, got %v", err)
	}
	if s.Code() != codes.DeadlineExceeded {
		t.Errorf("code: got %v, want DeadlineExceeded", s.Code())
	}
	// The deadline is 5s in production; we just assert we DID NOT block until
	// TCP keepalive (>>30s). A 6s upper bound generously absorbs scheduler
	// jitter without making the test reliant on exact timing.
	if elapsed > 6*time.Second {
		t.Errorf("first-recv took %v, expected ≤ ~5s deadline", elapsed)
	}
}

// TestRequireLoopbackForMedia is a table-driven coverage check for the
// loopback guard. Phase 1 has no mTLS, so non-loopback addrs must be refused
// at boot.
func TestRequireLoopbackForMedia(t *testing.T) {
	t.Parallel()
	cases := []struct {
		addr    string
		wantErr bool
	}{
		// Accept: explicit loopback.
		{"127.0.0.1:0", false},
		{"127.0.0.1:7880", false},
		{"[::1]:0", false},
		{"[::1]:7880", false},
		{"localhost:0", false},
		// Reject: missing host (= all interfaces).
		{":7880", true},
		// Reject: wildcard / public IP / non-loopback name.
		{"0.0.0.0:7880", true},
		{"192.168.1.1:7880", true},
		{"example.com:7880", true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.addr, func(t *testing.T) {
			t.Parallel()
			err := requireLoopbackForMedia(tc.addr)
			if (err != nil) != tc.wantErr {
				t.Fatalf("requireLoopbackForMedia(%q): err=%v, wantErr=%v", tc.addr, err, tc.wantErr)
			}
		})
	}
}

// waitForCondition polls fn until it returns true or the deadline passes.
func waitForCondition(timeout time.Duration, fn func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fn()
}

// captureDispatcher implements mediaInboundDispatcher and records every
// inbound envelope it sees. Used by TestMediaRegistry_SdpSignalDispatch.
type captureDispatcher struct {
	mu              sync.Mutex
	envelopes       []capturedEnvelope
	evictedNodeIDs  []string
}

type capturedEnvelope struct {
	nodeID string
	env    *mediaproto.Envelope
}

func (d *captureDispatcher) HandleMediaInbound(nodeID string, env *mediaproto.Envelope) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.envelopes = append(d.envelopes, capturedEnvelope{nodeID: nodeID, env: env})
}

func (d *captureDispatcher) NodeEvicted(nodeID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.evictedNodeIDs = append(d.evictedNodeIDs, nodeID)
}

func (d *captureDispatcher) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.envelopes)
}

func (d *captureDispatcher) snapshot() []capturedEnvelope {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]capturedEnvelope, len(d.envelopes))
	copy(out, d.envelopes)
	return out
}

func (d *captureDispatcher) evictedSnapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, len(d.evictedNodeIDs))
	copy(out, d.evictedNodeIDs)
	return out
}

// TestMediaRegistry_SdpSignalDispatch locks in the phase-1 final-pass
// contract: when a media node sends an SdpSignal / IceCandidateSignal /
// SessionEstablished / SessionEnded envelope on the sidechannel, the
// registered dispatcher receives it. Registry-housekeeping envelopes
// (Heartbeat, Ack) DO NOT reach the dispatcher.
func TestMediaRegistry_SdpSignalDispatch(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	registry := newMediaNodeRegistry()
	disp := &captureDispatcher{}
	server := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(server, newMediaSidechannelServer(registry, logger, disp))
	go func() { _ = server.Serve(lis) }()
	defer server.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := mediaproto.NewMediaControlClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	// First envelope MUST be RegisterNode.
	const nodeID = "dispatch-node-1"
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId:      nodeID,
				Region:      "us-east",
				MaxSessions: 1,
			},
		},
	}); err != nil {
		t.Fatalf("send register: %v", err)
	}
	if !waitForCondition(2*time.Second, func() bool { return registry.size() == 1 }) {
		t.Fatalf("node not registered")
	}

	// Heartbeat — MUST NOT reach the dispatcher.
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_Heartbeat{
			Heartbeat: &mediaproto.Heartbeat{Accepting: true},
		},
	}); err != nil {
		t.Fatalf("send heartbeat: %v", err)
	}

	// SdpSignal — MUST reach the dispatcher.
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SdpSignal{
			SdpSignal: &mediaproto.SdpSignal{
				SessionId: "42",
				SdpType:   "offer",
				Sdp:       "v=0\r\n...",
			},
		},
	}); err != nil {
		t.Fatalf("send sdp signal: %v", err)
	}

	// IceCandidateSignal — MUST reach the dispatcher.
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_IceCandidateSignal{
			IceCandidateSignal: &mediaproto.IceCandidateSignal{
				SessionId:     "42",
				CandidateJson: `{"candidate":"candidate:1 1 udp 100 1.2.3.4 5 typ host"}`,
			},
		},
	}); err != nil {
		t.Fatalf("send ice signal: %v", err)
	}

	// SessionEnded — MUST reach the dispatcher.
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SessionEnded{
			SessionEnded: &mediaproto.SessionEnded{
				SessionId: "42",
				Reason:    mediaproto.SessionEnded_REASON_CLIENT_DISCONNECT,
			},
		},
	}); err != nil {
		t.Fatalf("send session ended: %v", err)
	}

	// Wait for all three dispatchable envelopes to land.
	if !waitForCondition(2*time.Second, func() bool { return disp.count() >= 3 }) {
		t.Fatalf("dispatcher saw only %d envelopes, want 3", disp.count())
	}

	got := disp.snapshot()
	if len(got) != 3 {
		t.Fatalf("dispatcher captured %d envelopes, want 3", len(got))
	}
	for i, ce := range got {
		if ce.nodeID != nodeID {
			t.Errorf("envelope %d: nodeID=%q, want %q", i, ce.nodeID, nodeID)
		}
	}
	if _, ok := got[0].env.GetPayload().(*mediaproto.Envelope_SdpSignal); !ok {
		t.Errorf("envelope 0: type %T, want SdpSignal", got[0].env.GetPayload())
	}
	if _, ok := got[1].env.GetPayload().(*mediaproto.Envelope_IceCandidateSignal); !ok {
		t.Errorf("envelope 1: type %T, want IceCandidateSignal", got[1].env.GetPayload())
	}
	if _, ok := got[2].env.GetPayload().(*mediaproto.Envelope_SessionEnded); !ok {
		t.Errorf("envelope 2: type %T, want SessionEnded", got[2].env.GetPayload())
	}

	_ = stream.CloseSend()
}

// TestMediaRegistry_DuplicateNodeIDDoesntEvictNewStream locks in follow-up
// #7: when a media node reconnects with the same node_id while the previous
// stream is still draining, the second stream's entry MUST survive the
// first stream's deferred eviction. The fix uses a per-stream UUID and the
// evictIfStream guard.
func TestMediaRegistry_DuplicateNodeIDDoesntEvictNewStream(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	registry := newMediaNodeRegistry()

	// Simulate the old stream registering and getting its UUID stashed.
	const nodeID = "race-node"
	firstUUID := registry.register(&mediaproto.RegisterNode{
		NodeId: nodeID, Region: "x", MaxSessions: 1,
	}, nil)
	if firstUUID == "" {
		t.Fatal("first register returned empty UUID")
	}

	// While the first stream is still notionally alive, a SECOND stream
	// connects with the same node_id (the duplicate race). register()
	// overwrites the entry with a new UUID.
	secondUUID := registry.register(&mediaproto.RegisterNode{
		NodeId: nodeID, Region: "x", MaxSessions: 1,
	}, nil)
	if secondUUID == "" {
		t.Fatal("second register returned empty UUID")
	}
	if firstUUID == secondUUID {
		t.Fatal("expected distinct UUIDs across registrations")
	}
	if registry.size() != 1 {
		t.Fatalf("expected size 1, got %d", registry.size())
	}

	// Now the OLD stream's deferred evict fires — but with the first UUID,
	// not the second. It MUST be a no-op.
	if registry.evictIfStream(nodeID, firstUUID) {
		t.Fatal("old stream's evict should be a no-op when entry belongs to newer stream")
	}
	if registry.size() != 1 {
		t.Fatalf("entry vanished after stale evict; size=%d", registry.size())
	}

	// The SECOND stream's deferred evict still works correctly.
	if !registry.evictIfStream(nodeID, secondUUID) {
		t.Fatal("current stream's evict should succeed")
	}
	if registry.size() != 0 {
		t.Fatalf("entry should be gone after current stream's evict; size=%d", registry.size())
	}

	// Calling evictIfStream on an already-empty entry is also a no-op.
	if registry.evictIfStream(nodeID, secondUUID) {
		t.Fatal("evictIfStream on missing entry should return false")
	}
	_ = logger
}

// TestMediaRegistry_PickNode_NoNodes locks in the "no media available"
// path: pickNode returns "" when the registry is empty, signaling
// setupWebRTCForClient to degrade to text-only.
func TestMediaRegistry_PickNode_NoNodes(t *testing.T) {
	t.Parallel()
	registry := newMediaNodeRegistry()
	if got := registry.pickNode(); got != "" {
		t.Errorf("pickNode on empty registry: got %q, want \"\"", got)
	}
}

// TestMediaRegistry_PickNode_PicksAccepting locks in the basic
// pickNode-returns-a-registered-node contract.
func TestMediaRegistry_PickNode_PicksAccepting(t *testing.T) {
	t.Parallel()
	registry := newMediaNodeRegistry()
	registry.register(&mediaproto.RegisterNode{NodeId: "n-only", Region: "x", MaxSessions: 1}, nil)
	if got := registry.pickNode(); got != "n-only" {
		t.Errorf("pickNode: got %q, want %q", got, "n-only")
	}
}

// TestMediaRegistry_StreamCloseFiresNodeEvicted locks in HIGH #2: when the
// sidechannel stream closes, the dispatcher's NodeEvicted hook fires so
// per-vServer client maps can clear their bookkeeping.
func TestMediaRegistry_StreamCloseFiresNodeEvicted(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	registry := newMediaNodeRegistry()
	disp := &captureDispatcher{}
	server := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(server, newMediaSidechannelServer(registry, logger, disp))
	go func() { _ = server.Serve(lis) }()
	defer server.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := mediaproto.NewMediaControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := client.Sidechannel(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	const nodeID = "evict-test-1"
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId: nodeID, Region: "x", MaxSessions: 1,
			},
		},
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if !waitForCondition(2*time.Second, func() bool { return registry.size() == 1 }) {
		t.Fatalf("node not registered")
	}

	_ = stream.CloseSend()
	// Drain server stream so its deferred eviction runs.
	for {
		if _, err := stream.Recv(); err != nil {
			break
		}
	}

	if !waitForCondition(2*time.Second, func() bool {
		for _, id := range disp.evictedSnapshot() {
			if id == nodeID {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("NodeEvicted not fired for %s; got %v", nodeID, disp.evictedSnapshot())
	}
}

// TestMediaRegistry_SweeperFiresNodeEvicted locks in HIGH #2 on the
// sweeper path: a stale node aged out by the sweeper still notifies the
// dispatcher so clients on that node aren't orphaned.
func TestMediaRegistry_SweeperFiresNodeEvicted(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	registry := newMediaNodeRegistry()
	registry.timeout = 25 * time.Millisecond

	var nowNs atomic.Int64
	nowNs.Store(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixNano())
	registry.now = func() time.Time { return time.Unix(0, nowNs.Load()) }

	disp := &captureDispatcher{}
	registry.register(&mediaproto.RegisterNode{NodeId: "stale-1", Region: "x", MaxSessions: 1}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	// Quick interval so test doesn't wait long. nowNs advancement does the
	// actual time movement.
	go registry.runSweeper(ctx, 10*time.Millisecond, logger, disp, done)
	defer func() {
		cancel()
		<-done
	}()

	// Advance clock past timeout.
	nowNs.Add(int64(50 * time.Millisecond))

	if !waitForCondition(2*time.Second, func() bool {
		for _, id := range disp.evictedSnapshot() {
			if id == "stale-1" {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("sweeper did not fire NodeEvicted: %v", disp.evictedSnapshot())
	}
}
