// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package oracleclient

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"hachiman/server/pkg/management"
)

// TestClient_ProxiesAllThreeRPCs spins up a fake Management gRPC server
// and asserts that the wrapper forwards RegisterMediaNode / MediaNodeHeartbeat
// / PlaceMediaSession verbatim. Covers the proto-binding plumbing as well as
// the wrapper's parameter pass-through.
func TestClient_ProxiesAllThreeRPCs(t *testing.T) {
	fake := &fakeOracle{
		placeResponse: &management.PlaceMediaSessionResponse{
			NodeId:       "node-fake",
			SignalingUrl: "wss://fake.media.example.com/voice",
		},
	}
	addr, stop := startFakeOracle(t, fake)
	defer stop()

	c, err := New(addr)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// RegisterMediaNode
	if _, err := c.RegisterMediaNode(ctx, &management.RegisterMediaNodeRequest{
		NodeId:          "node-1",
		Region:          "us-east",
		SignalingUrl:    "wss://10.0.0.1/voice",
		MaxSessions:     200,
		Version:         "test-1.0",
	}); err != nil {
		t.Fatalf("RegisterMediaNode: %v", err)
	}
	if fake.registerLast == nil || fake.registerLast.GetNodeId() != "node-1" {
		t.Errorf("fake never observed RegisterMediaNode; got %+v", fake.registerLast)
	}

	// MediaNodeHeartbeat
	if _, err := c.MediaNodeHeartbeat(ctx, &management.MediaNodeHeartbeatRequest{
		NodeId:         "node-1",
		ActiveSessions: 12,
		CpuFraction:    0.3,
		Accepting:      true,
	}); err != nil {
		t.Fatalf("MediaNodeHeartbeat: %v", err)
	}
	if fake.heartbeatLast == nil || fake.heartbeatLast.GetActiveSessions() != 12 {
		t.Errorf("fake never observed Heartbeat; got %+v", fake.heartbeatLast)
	}

	// PlaceMediaSession
	resp, err := c.PlaceMediaSession(ctx, &management.PlaceMediaSessionRequest{
		ChannelId:  "chan-99",
		HomeRegion: "us-east",
		GuildId:    "guild-x",
	})
	if err != nil {
		t.Fatalf("PlaceMediaSession: %v", err)
	}
	if resp.GetNodeId() != "node-fake" || resp.GetSignalingUrl() != "wss://fake.media.example.com/voice" {
		t.Errorf("PlaceMediaSession response = %+v, want node-fake + signaling url", resp)
	}
	if fake.placeLast == nil || fake.placeLast.GetChannelId() != "chan-99" || fake.placeLast.GetGuildId() != "guild-x" {
		t.Errorf("fake never observed PlaceMediaSession; got %+v", fake.placeLast)
	}
}

// TestClient_NilReceiverReturnsErrUnconfigured: callers must be able to
// detect the "Oracle disabled" path via errors.Is, without a separate nil
// check at every call site.
func TestClient_NilReceiverReturnsErrUnconfigured(t *testing.T) {
	t.Parallel()
	var c *Client
	ctx := context.Background()
	if _, err := c.RegisterMediaNode(ctx, &management.RegisterMediaNodeRequest{}); !errors.Is(err, ErrUnconfigured) {
		t.Errorf("RegisterMediaNode on nil receiver: err = %v, want ErrUnconfigured", err)
	}
	if _, err := c.MediaNodeHeartbeat(ctx, &management.MediaNodeHeartbeatRequest{}); !errors.Is(err, ErrUnconfigured) {
		t.Errorf("MediaNodeHeartbeat on nil receiver: err = %v, want ErrUnconfigured", err)
	}
	if _, err := c.PlaceMediaSession(ctx, &management.PlaceMediaSessionRequest{}); !errors.Is(err, ErrUnconfigured) {
		t.Errorf("PlaceMediaSession on nil receiver: err = %v, want ErrUnconfigured", err)
	}
}

// TestClient_PropagatesGrpcStatusError: when Oracle returns a structured
// status (e.g. RESOURCE_EXHAUSTED on PlaceMediaSession), the wrapper must
// surface it verbatim so the caller can branch on the code.
func TestClient_PropagatesGrpcStatusError(t *testing.T) {
	fake := &fakeOracle{
		placeErr: status.Error(codes.ResourceExhausted, "no nodes available"),
	}
	addr, stop := startFakeOracle(t, fake)
	defer stop()

	c, err := New(addr)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = c.PlaceMediaSession(ctx, &management.PlaceMediaSessionRequest{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %T: %v", err, err)
	}
	if st.Code() != codes.ResourceExhausted {
		t.Errorf("status code: got %v, want ResourceExhausted", st.Code())
	}
}

// TestNew_RejectsEmptyAddr: empty addr is the "Oracle not configured" case
// at the call site — the wrapper should refuse to dial. Boot path catches
// the nil receiver path explicitly.
func TestNew_RejectsEmptyAddr(t *testing.T) {
	t.Parallel()
	if _, err := New(""); err == nil {
		t.Error("New(\"\"): want error, got nil")
	}
}

// --- fake Oracle gRPC server ------------------------------------------------

type fakeOracle struct {
	management.UnimplementedManagementServer

	placeResponse *management.PlaceMediaSessionResponse
	placeErr      error

	registerLast  *management.RegisterMediaNodeRequest
	heartbeatLast *management.MediaNodeHeartbeatRequest
	placeLast     *management.PlaceMediaSessionRequest
}

func (f *fakeOracle) RegisterMediaNode(_ context.Context, req *management.RegisterMediaNodeRequest) (*management.RegisterMediaNodeResponse, error) {
	f.registerLast = req
	return &management.RegisterMediaNodeResponse{}, nil
}

func (f *fakeOracle) MediaNodeHeartbeat(_ context.Context, req *management.MediaNodeHeartbeatRequest) (*management.MediaNodeHeartbeatResponse, error) {
	f.heartbeatLast = req
	return &management.MediaNodeHeartbeatResponse{}, nil
}

func (f *fakeOracle) PlaceMediaSession(_ context.Context, req *management.PlaceMediaSessionRequest) (*management.PlaceMediaSessionResponse, error) {
	f.placeLast = req
	if f.placeErr != nil {
		return nil, f.placeErr
	}
	return f.placeResponse, nil
}

func startFakeOracle(t *testing.T, fake *fakeOracle) (string, func()) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	management.RegisterManagementServer(gs, fake)
	go func() {
		_ = gs.Serve(lis)
	}()
	return lis.Addr().String(), func() {
		gs.GracefulStop()
		_ = lis.Close()
	}
}
