// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Package voicetoken mints (gateway) and verifies (media) the short-lived
// PASETO v4.public tokens that admit a client to a media node's voice WS.
// Contract: docs/gateway-protocol.md §7.
//
// PASETO over JWT for the no-alg-confusion guarantee. The token is minted
// before the client has a PeerConnection, so there is no DTLS/ICE binding;
// the short TTL + per-node jti replay LRU + aud binding bound a leak.
package voicetoken

import "time"

// Claims is the token payload. Wire keys are camelCase (sessionId, userId,
// deviceId, guildId, channelId) plus the standard PASETO aud/jti/iat/exp.
type Claims struct {
	SessionID string `json:"sessionId"` // gateway session id
	UserID    string `json:"userId"`
	// DeviceID is the gateway session's device (§12.13). The token library
	// accepts it empty; hachiman-media requires it (E2EE roster identity).
	DeviceID    string    `json:"deviceId"`
	GuildID     string    `json:"guildId"`
	ChannelID   string    `json:"channelId"` // = media room id
	MediaNodeID string    `json:"aud"`       // must equal the verifying node's id
	JTI         string    `json:"jti"`
	IssuedAt    time.Time `json:"iat"`
	ExpiresAt   time.Time `json:"exp"` // 60–120 s after iat
}

// MinTTL / MaxTTL bound exp-iat on both mint and verify. MaxClockSkew is the
// tolerated forward skew of iat between the gateway and media clocks.
const (
	MinTTL       = 60 * time.Second
	MaxTTL       = 120 * time.Second
	DefaultTTL   = 90 * time.Second
	MaxClockSkew = 30 * time.Second
)
