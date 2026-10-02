// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"log"
	"time"

	"hachiman/server/pkg/management"
	"hachiman/server/pkg/oracleclient"
)

const heartbeatInterval = 10 * time.Second

// runOracleRegistration registers the node and heartbeats every 10 s until
// ctx ends. Oracle being down never kills the node: registration retries with
// capped backoff, and a failed heartbeat drops back to re-registering (Oracle
// may have restarted and lost or expired the row). On shutdown it sends a
// best-effort accepting=false heartbeat so placement stops sending users here.
func runOracleRegistration(ctx context.Context, oc *oracleclient.Client, a args, active func() int, logger *log.Logger) {
	if oc == nil {
		return
	}
	reg := &management.RegisterMediaNodeRequest{
		NodeId: a.NodeID, Region: a.Region, SignalingUrl: a.SignalingURL,
		MaxSessions: uint32(a.MaxSessions), Version: version,
	}
	heartbeat := func(ctx context.Context, accepting bool) error {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		// ponytail: cpu_fraction is always 0; add a sampler if placement starts weighting it.
		_, err := oc.MediaNodeHeartbeat(cctx, &management.MediaNodeHeartbeatRequest{
			NodeId: a.NodeID, ActiveSessions: uint32(active()), Accepting: accepting,
		})
		return err
	}

	registered := false
	backoff := time.Second
	for {
		wait := heartbeatInterval
		if !registered {
			cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			_, err := oc.RegisterMediaNode(cctx, reg)
			cancel()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				logger.Printf("oracle: register failed (retry in %s): %v", backoff, err)
				wait = backoff
				backoff = min(backoff*2, 30*time.Second)
			} else {
				logger.Printf("oracle: registered node %s", a.NodeID)
				registered, backoff = true, time.Second
			}
		}
		if registered {
			if err := heartbeat(ctx, true); err != nil && ctx.Err() == nil {
				logger.Printf("oracle: heartbeat failed, re-registering: %v", err)
				registered = false
				wait = backoff
			}
		}
		select {
		case <-ctx.Done():
			if registered {
				_ = heartbeat(context.Background(), false)
			}
			return
		case <-time.After(wait):
		}
	}
}
