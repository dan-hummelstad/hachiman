// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// runKickSubscriber listens on media:{nodeId} for gateway kicks
// (`{"op":"kick","sessionId":...,"channelId":...}`) until ctx ends. The first subscribe is
// retried with backoff; after that go-redis' PubSub reconnects on its own.
func runKickSubscriber(ctx context.Context, rdb *redis.Client, nodeID string, srv *voiceServer, logger *log.Logger) {
	channel := "media:" + nodeID
	backoff := time.Second
	for {
		ps := rdb.Subscribe(ctx, channel)
		if _, err := ps.Receive(ctx); err != nil {
			_ = ps.Close()
			if ctx.Err() != nil {
				return
			}
			logger.Printf("redis: subscribe %s failed (retry in %s): %v", channel, backoff, err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		logger.Printf("redis: subscribed to %s", channel)
		go func() { <-ctx.Done(); _ = ps.Close() }()
		for msg := range ps.Channel() { // closed by ps.Close on ctx end
			var m struct {
				Op        string `json:"op"`
				SessionID string `json:"sessionId"`
				ChannelID string `json:"channelId"` // optional: only kick if the session is in this room
			}
			if err := json.Unmarshal([]byte(msg.Payload), &m); err != nil || m.Op != "kick" || m.SessionID == "" {
				logger.Printf("redis: ignoring %s message %q", channel, msg.Payload)
				continue
			}
			srv.kick(m.SessionID, m.ChannelID)
		}
		return
	}
}
