// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"mumble.info/grumble/pkg/management"
	"mumble.info/grumble/pkg/mediaproto"
	"mumble.info/grumble/pkg/oracleclient"
)

// TestSidechannel_MirrorsRegisterAndHeartbeatToOracle locks in that the
// sidechannel server forwards RegisterNode + Heartbeat envelopes to Oracle
// best-effort. The local registry is the dispatch source of truth; Oracle
// gets a mirror so its media_nodes table reflects the live fleet.
func TestSidechannel_MirrorsRegisterAndHeartbeatToOracle(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	oc := &recordingOracle{}

	registry := newMediaNodeRegistry()
	srv := newMediaSidechannelServer(registry, logger, nil).withOracle(oc)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer lis.Close()
	gs := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	defer gs.GracefulStop()

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
		t.Fatalf("Sidechannel: %v", err)
	}

	// RegisterNode → expect mirror to fire.
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId:          "node-1",
				Region:          "us-east",
				SidechannelAddr: "10.0.0.1:7881",
				MaxSessions:     200,
				Version:         "test-1.0",
			},
		},
	}); err != nil {
		t.Fatalf("send RegisterNode: %v", err)
	}
	if err := waitFor(t, 2*time.Second, func() bool { return oc.registerCount() >= 1 }); err != nil {
		t.Fatalf("RegisterMediaNode mirror not observed: %v", err)
	}
	if got := oc.lastRegister().GetNodeId(); got != "node-1" {
		t.Errorf("Oracle saw RegisterMediaNode.node_id = %q, want %q", got, "node-1")
	}
	if got := oc.lastRegister().GetRegion(); got != "us-east" {
		t.Errorf("Oracle saw RegisterMediaNode.region = %q, want %q", got, "us-east")
	}

	// Heartbeat → expect mirror to fire.
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_Heartbeat{
			Heartbeat: &mediaproto.Heartbeat{
				ActiveSessions: 7,
				CpuFraction:    0.5,
				Accepting:      true,
			},
		},
	}); err != nil {
		t.Fatalf("send Heartbeat: %v", err)
	}
	if err := waitFor(t, 2*time.Second, func() bool { return oc.heartbeatCount() >= 1 }); err != nil {
		t.Fatalf("MediaNodeHeartbeat mirror not observed: %v", err)
	}
	if got := oc.lastHeartbeat().GetActiveSessions(); got != 7 {
		t.Errorf("Oracle saw Heartbeat.active_sessions = %d, want 7", got)
	}
}

// TestSidechannel_NoOracleMirrorWhenUnconfigured locks in the "Oracle off"
// path: when withOracle was never called, the dispatcher must not invoke any
// Oracle RPC (proven by an oracle whose calls panic).
func TestSidechannel_NoOracleMirrorWhenUnconfigured(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	registry := newMediaNodeRegistry()
	// Build server WITHOUT withOracle — the field stays nil.
	srv := newMediaSidechannelServer(registry, logger, nil)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer lis.Close()
	gs := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	defer gs.GracefulStop()

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
		t.Fatalf("Sidechannel: %v", err)
	}
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{
				NodeId: "node-1",
				Region: "us-east",
			},
		},
	}); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Wait for the registry to acknowledge the registration; without any
	// Oracle mirror this is the only observable signal.
	if err := waitFor(t, 1*time.Second, func() bool { return registry.size() >= 1 }); err != nil {
		t.Fatalf("local registry didn't see RegisterNode: %v", err)
	}
}

// TestSidechannel_DropsOracleUnconfiguredSilently: the mirror should treat
// ErrUnconfigured as "Oracle off" and not log it as an error or back-pressure
// the stream. Cover-by-construction: configure an oracle that returns
// ErrUnconfigured and assert the stream stays healthy.
func TestSidechannel_DropsOracleUnconfiguredSilently(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	oc := &recordingOracle{
		registerErr:  oracleclient.ErrUnconfigured,
		heartbeatErr: oracleclient.ErrUnconfigured,
	}
	registry := newMediaNodeRegistry()
	srv := newMediaSidechannelServer(registry, logger, nil).withOracle(oc)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer lis.Close()
	gs := grpc.NewServer()
	mediaproto.RegisterMediaControlServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	defer gs.GracefulStop()

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
		t.Fatalf("Sidechannel: %v", err)
	}
	if err := stream.Send(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_RegisterNode{
			RegisterNode: &mediaproto.RegisterNode{NodeId: "node-1", Region: "us-east"},
		},
	}); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Even with an Oracle that "denies" every call, the local registry
	// must still register the node — the Oracle mirror is best-effort and
	// errors must not block the local dispatch index.
	if err := waitFor(t, 1*time.Second, func() bool { return registry.size() >= 1 }); err != nil {
		t.Fatalf("local registry failed after Oracle returned ErrUnconfigured: %v", err)
	}
}

// recordingOracle is a tiny in-process oracleClient mock used by the control-
// side tests. Counts calls + records the last request per RPC so assertions
// can check both fire-count and payload shape.
type recordingOracle struct {
	mu              sync.Mutex
	registerCalls   int32
	heartbeatCalls  int32
	placeCalls      int32
	lastRegisterReq  *management.RegisterMediaNodeRequest
	lastHeartbeatReq *management.MediaNodeHeartbeatRequest
	lastPlace        *management.PlaceMediaSessionRequest

	// optional canned responses / errors for placement tests.
	placeResp    *management.PlaceMediaSessionResponse
	placeErr     error
	registerErr  error
	heartbeatErr error
}

func (o *recordingOracle) RegisterMediaNode(_ context.Context, req *management.RegisterMediaNodeRequest) (*management.RegisterMediaNodeResponse, error) {
	o.mu.Lock()
	o.lastRegisterReq = req
	o.mu.Unlock()
	atomic.AddInt32(&o.registerCalls, 1)
	if o.registerErr != nil {
		return nil, o.registerErr
	}
	return &management.RegisterMediaNodeResponse{}, nil
}

func (o *recordingOracle) MediaNodeHeartbeat(_ context.Context, req *management.MediaNodeHeartbeatRequest) (*management.MediaNodeHeartbeatResponse, error) {
	o.mu.Lock()
	o.lastHeartbeatReq = req
	o.mu.Unlock()
	atomic.AddInt32(&o.heartbeatCalls, 1)
	if o.heartbeatErr != nil {
		return nil, o.heartbeatErr
	}
	return &management.MediaNodeHeartbeatResponse{}, nil
}

func (o *recordingOracle) PlaceMediaSession(_ context.Context, req *management.PlaceMediaSessionRequest) (*management.PlaceMediaSessionResponse, error) {
	o.mu.Lock()
	o.lastPlace = req
	o.mu.Unlock()
	atomic.AddInt32(&o.placeCalls, 1)
	if o.placeErr != nil {
		return nil, o.placeErr
	}
	if o.placeResp != nil {
		return o.placeResp, nil
	}
	return &management.PlaceMediaSessionResponse{}, nil
}

func (o *recordingOracle) registerCount() int32  { return atomic.LoadInt32(&o.registerCalls) }
func (o *recordingOracle) heartbeatCount() int32 { return atomic.LoadInt32(&o.heartbeatCalls) }
func (o *recordingOracle) placeCount() int32     { return atomic.LoadInt32(&o.placeCalls) }

func (o *recordingOracle) lastRegister() *management.RegisterMediaNodeRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastRegisterReq
}

func (o *recordingOracle) lastHeartbeat() *management.MediaNodeHeartbeatRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastHeartbeatReq
}

func (o *recordingOracle) lastPlaceReq() *management.PlaceMediaSessionRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastPlace
}

// waitFor polls cond until it returns true or the deadline expires. Returns
// a deadline-exceeded error otherwise. 10ms tick — fast enough for test
// loops, slow enough not to peg the CPU.
func waitFor(t *testing.T, d time.Duration, cond func() bool) error {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("waitFor: deadline exceeded")
}
