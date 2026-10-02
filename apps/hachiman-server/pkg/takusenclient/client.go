// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Package takusenclient wraps the generated Management gRPC client (contract
// §9): hachiman-media calls RegisterMediaNode / MediaNodeHeartbeat,
// hachiman-gateway calls PlaceMediaSession.
//
// Reconnect model: gRPC's client-side connection manager already does its own
// re-dial on transient errors, so this wrapper just dials lazily and lets the
// underlying connection's state machine handle blips. ErrUnconfigured is the
// sentinel callers test for to distinguish "Takusen disabled" from "Takusen call
// failed".
package takusenclient

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"hachiman/server/pkg/management"
)

// ErrUnconfigured is returned by every Client method when the Client is nil
// (Takusen address not configured). Callers compare with errors.Is to fall back
// to local behaviour without logging an error.
var ErrUnconfigured = errors.New("takusenclient: not configured")

// Client holds the underlying gRPC client + connection for the lifetime of
// the process. Construct via New; close via
// Close (rarely needed since lifetime equals process lifetime).
type Client struct {
	conn   *grpc.ClientConn
	client management.ManagementClient
}

// New dials addr and returns a Client.
//
// SECURITY: insecure-creds. Takusen's gRPC server implements
// RegisterMediaNode / MediaNodeHeartbeat / PlaceMediaSession with NO
// application-layer auth — anyone with network reachability to the port
// can inject fake nodes or drain real ones. Until mTLS lands the trust
// boundary is the network layer: Takusen defaults to loopback bind
// (apps/takusen/src/grpc/server.ts) and production deploys are expected to
// keep the cross-VPC path inside a private subnet / security group.
//
// TODO(phase 5, follow-up #10): swap insecure.NewCredentials() for
// credentials.NewTLS({...}) with a mutual-TLS cert chain. When the cert bundle is wired here it MUST be wired on the Takusen side
// (apps/takusen/src/grpc/server.ts) in the same change.
//
// addr must be non-empty.
func New(addr string) (*Client, error) {
	if addr == "" {
		return nil, fmt.Errorf("takusenclient: empty addr")
	}
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("takusenclient: dial %q: %w", addr, err)
	}
	return &Client{
		conn:   conn,
		client: management.NewManagementClient(conn),
	}, nil
}

// Close releases the underlying gRPC connection. Idempotent on nil.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// RegisterMediaNode proxies to Takusen. A nil receiver returns ErrUnconfigured
// so callers can branch on it without a separate nil check.
func (c *Client) RegisterMediaNode(ctx context.Context, req *management.RegisterMediaNodeRequest) (*management.RegisterMediaNodeResponse, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	return c.client.RegisterMediaNode(ctx, req)
}

// MediaNodeHeartbeat proxies to Takusen. A nil receiver returns ErrUnconfigured.
func (c *Client) MediaNodeHeartbeat(ctx context.Context, req *management.MediaNodeHeartbeatRequest) (*management.MediaNodeHeartbeatResponse, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	return c.client.MediaNodeHeartbeat(ctx, req)
}

// PlaceMediaSession proxies to Takusen. A nil receiver returns ErrUnconfigured.
func (c *Client) PlaceMediaSession(ctx context.Context, req *management.PlaceMediaSessionRequest) (*management.PlaceMediaSessionResponse, error) {
	if c == nil {
		return nil, ErrUnconfigured
	}
	return c.client.PlaceMediaSession(ctx, req)
}
