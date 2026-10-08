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

	"hachiman/server/pkg/voicetoken"
)

// publishVoiceDisconnected sends the internal VOICE_DISCONNECTED (§8) to
// device:{deviceId}: the call of this token ended without a kick. The gateway
// session that minted the token clears its voice state; clients never see it.
func publishVoiceDisconnected(rdb *redis.Client, c *voicetoken.Claims, logger *log.Logger) {
	d, _ := json.Marshal(map[string]string{"sessionId": c.SessionID, "channelId": c.ChannelID, "jti": c.JTI})
	env, _ := json.Marshal(map[string]any{"t": "VOICE_DISCONNECTED", "d": json.RawMessage(d)})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Publish(ctx, "device:"+c.DeviceID, env).Err(); err != nil {
		logger.Printf("redis: publish VOICE_DISCONNECTED for session %s: %v", c.SessionID, err)
	}
}

// runKickSubscriber listens on media:{nodeId} for gateway kicks
// (`{"op":"kick","sessionId":...,"channelId":...}`) and server mutes
// (`{"op":"mute","sessionId":...,"channelId":...,"mute":bool}`) until ctx ends. The first subscribe is
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
				ChannelID string `json:"channelId"` // optional: only act if the session is in this room
				Mute      bool   `json:"mute"`
			}
			if err := json.Unmarshal([]byte(msg.Payload), &m); err != nil || m.SessionID == "" || (m.Op != "kick" && m.Op != "mute") {
				logger.Printf("redis: ignoring %s message %q", channel, msg.Payload)
				continue
			}
			if m.Op == "mute" {
				srv.setMuted(m.SessionID, m.ChannelID, m.Mute)
				continue
			}
			srv.kick(m.SessionID, m.ChannelID)
		}
		return
	}
}
