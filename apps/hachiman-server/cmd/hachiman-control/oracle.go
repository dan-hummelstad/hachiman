// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"

	"mumble.info/grumble/pkg/management"
	"mumble.info/grumble/pkg/oracleclient"
)

// oracleClient is the interface control uses to talk to Oracle. The
// production implementation is *oracleclient.Client; tests inject a fake
// (see media_registry_oracle_test.go) so we can assert the proxy paths
// without spinning up a real gRPC server in every test.
//
// Methods MUST be safe to call with a nil receiver — the production client
// returns oracleclient.ErrUnconfigured in that case so the callers' fallback
// paths fire cleanly.
type oracleClient interface {
	RegisterMediaNode(ctx context.Context, req *management.RegisterMediaNodeRequest) (*management.RegisterMediaNodeResponse, error)
	MediaNodeHeartbeat(ctx context.Context, req *management.MediaNodeHeartbeatRequest) (*management.MediaNodeHeartbeatResponse, error)
	PlaceMediaSession(ctx context.Context, req *management.PlaceMediaSessionRequest) (*management.PlaceMediaSessionResponse, error)
}

// newOracleClient dials Oracle and returns the wrapped client. Used from
// grumble.go at boot when --oracle-addr is non-empty. Wraps the package-level
// constructor so tests can swap the implementation at a single seam.
func newOracleClient(addr string) (oracleClient, error) {
	return oracleclient.New(addr)
}
