// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"mumble.info/grumble/pkg/management"
	"mumble.info/grumble/pkg/oracleclient"
)

// TestChoosePlacement_OracleHappyPath: Oracle returns a node that the local
// registry knows about. Caller gets Oracle's node + assigned_ssrc.
func TestChoosePlacement_OracleHappyPath(t *testing.T) {
	t.Parallel()
	oracle := &placementOracle{
		resp: &management.PlaceMediaSessionResponse{
			NodeId:       "node-a",
			AssignedSsrc: 1234,
		},
	}
	node, ssrc := choosePlacement(placementInputs{
		oracle:        oracle,
		localPickNode: func() string { return "node-fallback" },
		localHas:      func(id string) bool { return id == "node-a" || id == "node-fallback" },
		channelID:     42,
		homeRegion:    "us-east",
	})
	if node != "node-a" {
		t.Errorf("nodeID: got %q, want node-a", node)
	}
	if ssrc != 1234 {
		t.Errorf("assignedSSRC: got %d, want 1234", ssrc)
	}
	if oracle.lastReq == nil {
		t.Fatal("Oracle.PlaceMediaSession never called")
	}
	if oracle.lastReq.GetChannelId() != 42 {
		t.Errorf("channel_id passed to Oracle: got %d, want 42", oracle.lastReq.GetChannelId())
	}
	if oracle.lastReq.GetHomeRegion() != "us-east" {
		t.Errorf("home_region passed to Oracle: got %q, want us-east", oracle.lastReq.GetHomeRegion())
	}
}

// TestChoosePlacement_FallbackOnOracleNil: Oracle unwired — local pickNode
// wins, assignedSSRC stays 0.
func TestChoosePlacement_FallbackOnOracleNil(t *testing.T) {
	t.Parallel()
	node, ssrc := choosePlacement(placementInputs{
		oracle:        nil,
		localPickNode: func() string { return "node-local" },
		localHas:      func(string) bool { return true },
	})
	if node != "node-local" {
		t.Errorf("nodeID: got %q, want node-local", node)
	}
	if ssrc != 0 {
		t.Errorf("assignedSSRC: got %d, want 0 (fallback)", ssrc)
	}
}

// TestChoosePlacement_FallbackOnErrUnconfigured: Oracle wired but reports
// ErrUnconfigured (e.g. nil receiver). Treated identically to unwired.
func TestChoosePlacement_FallbackOnErrUnconfigured(t *testing.T) {
	t.Parallel()
	oracle := &placementOracle{err: oracleclient.ErrUnconfigured}
	node, ssrc := choosePlacement(placementInputs{
		oracle:        oracle,
		localPickNode: func() string { return "node-local" },
		localHas:      func(string) bool { return true },
	})
	if node != "node-local" {
		t.Errorf("nodeID: got %q, want node-local", node)
	}
	if ssrc != 0 {
		t.Errorf("assignedSSRC: got %d, want 0", ssrc)
	}
}

// TestChoosePlacement_FallbackOnResourceExhausted: Oracle reports RESOURCE_
// EXHAUSTED — local fallback fires AND the failure is logged.
func TestChoosePlacement_FallbackOnResourceExhausted(t *testing.T) {
	t.Parallel()
	oracle := &placementOracle{err: status.Error(codes.ResourceExhausted, "no nodes")}
	var logged string
	node, ssrc := choosePlacement(placementInputs{
		oracle:        oracle,
		localPickNode: func() string { return "node-local" },
		localHas:      func(string) bool { return true },
		logf: func(format string, v ...interface{}) {
			logged = format
		},
	})
	if node != "node-local" {
		t.Errorf("nodeID: got %q, want node-local", node)
	}
	if ssrc != 0 {
		t.Errorf("assignedSSRC: got %d, want 0", ssrc)
	}
	if logged == "" {
		t.Error("expected a log line on RESOURCE_EXHAUSTED fallback")
	}
}

// TestChoosePlacement_OracleDriftFallsBackToLocal: Oracle returns a node the
// local dispatch index doesn't know about — fallback. The local registry is
// the authoritative dispatch source.
func TestChoosePlacement_OracleDriftFallsBackToLocal(t *testing.T) {
	t.Parallel()
	oracle := &placementOracle{
		resp: &management.PlaceMediaSessionResponse{NodeId: "node-ghost"},
	}
	node, ssrc := choosePlacement(placementInputs{
		oracle:        oracle,
		localPickNode: func() string { return "node-local" },
		localHas:      func(id string) bool { return id == "node-local" },
	})
	if node != "node-local" {
		t.Errorf("nodeID: got %q, want node-local (drift fallback)", node)
	}
	if ssrc != 0 {
		t.Errorf("assignedSSRC: got %d, want 0", ssrc)
	}
}

// TestChoosePlacement_EmptyOracleResponseFallsBack: Oracle returned 200 OK
// but with an empty node_id (defensive — shouldn't happen). Fall back.
func TestChoosePlacement_EmptyOracleResponseFallsBack(t *testing.T) {
	t.Parallel()
	oracle := &placementOracle{resp: &management.PlaceMediaSessionResponse{}}
	node, _ := choosePlacement(placementInputs{
		oracle:        oracle,
		localPickNode: func() string { return "node-local" },
		localHas:      func(string) bool { return true },
	})
	if node != "node-local" {
		t.Errorf("nodeID: got %q, want node-local", node)
	}
}

// TestChoosePlacement_NoLocalFallbackEither: empty local + Oracle returns
// error. Result is "", 0 — caller takes the "no media nodes available" path.
func TestChoosePlacement_NoLocalFallbackEither(t *testing.T) {
	t.Parallel()
	oracle := &placementOracle{err: status.Error(codes.Unavailable, "down")}
	node, _ := choosePlacement(placementInputs{
		oracle:        oracle,
		localPickNode: func() string { return "" },
		localHas:      func(string) bool { return false },
	})
	if node != "" {
		t.Errorf("nodeID: got %q, want empty (no fallback)", node)
	}
}

// TestChoosePlacement_NoOracleCallsWhenOracleNil_NoLogs: the Oracle-disabled
// path must not log an error (it's not an error). Pure observation: logf
// is never invoked.
func TestChoosePlacement_NoOracleCallsWhenOracleNil_NoLogs(t *testing.T) {
	t.Parallel()
	var logCount int
	choosePlacement(placementInputs{
		oracle:        nil,
		localPickNode: func() string { return "node-local" },
		localHas:      func(string) bool { return true },
		logf: func(format string, v ...interface{}) {
			logCount++
		},
	})
	if logCount != 0 {
		t.Errorf("expected 0 log lines with Oracle unwired, got %d", logCount)
	}
}

// placementOracle is a minimal oracleClient stub for choosePlacement tests.
// Returns the canned response or err on PlaceMediaSession; the other two RPCs
// just no-op since placement only calls PlaceMediaSession.
type placementOracle struct {
	resp    *management.PlaceMediaSessionResponse
	err     error
	lastReq *management.PlaceMediaSessionRequest
}

func (p *placementOracle) RegisterMediaNode(context.Context, *management.RegisterMediaNodeRequest) (*management.RegisterMediaNodeResponse, error) {
	return &management.RegisterMediaNodeResponse{}, nil
}
func (p *placementOracle) MediaNodeHeartbeat(context.Context, *management.MediaNodeHeartbeatRequest) (*management.MediaNodeHeartbeatResponse, error) {
	return &management.MediaNodeHeartbeatResponse{}, nil
}
func (p *placementOracle) PlaceMediaSession(_ context.Context, req *management.PlaceMediaSessionRequest) (*management.PlaceMediaSessionResponse, error) {
	p.lastReq = req
	if p.err != nil {
		return nil, p.err
	}
	if p.resp != nil {
		return p.resp, nil
	}
	return &management.PlaceMediaSessionResponse{}, nil
}

// _ keeps the errors import live in case of import-pruning tooling running
// over this test file before it lands.
var _ = errors.New
