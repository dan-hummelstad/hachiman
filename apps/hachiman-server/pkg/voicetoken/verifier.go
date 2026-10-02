// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"time"

	"aidanwoods.dev/go-paseto"
)

// ErrExpired is returned (wrapped) for tokens past exp, so media can map it to
// close code 4009 vs 4004 for every other failure.
var ErrExpired = errors.New("voicetoken: token expired")

// replayCapacity covers ~80 joins/s sustained under the 120 s max TTL.
const replayCapacity = 10_000

// Verifier validates tokens on a media node. Safe for concurrent use.
type Verifier struct {
	pub    paseto.V4AsymmetricPublicKey
	nodeID string
	replay *ReplayCache
}

// NewVerifier builds a Verifier from the signer's hex public key (the
// gateway's Signer.PublicKeyHex) bound to this media node's id.
func NewVerifier(pubKeyHex, nodeID string) (*Verifier, error) {
	if nodeID == "" {
		return nil, errors.New("voicetoken: node id required")
	}
	pub, err := paseto.NewV4AsymmetricPublicKeyFromHex(pubKeyHex)
	if err != nil {
		return nil, fmt.Errorf("voicetoken: public key: %w", err)
	}
	return &Verifier{pub: pub, nodeID: nodeID, replay: NewReplayCache(replayCapacity)}, nil
}

// NewVerifierFromSeed is the dev convenience: gateway and media point at the
// same seed file (generated if missing).
func NewVerifierFromSeed(seedPath, nodeID string) (*Verifier, error) {
	seed, err := loadOrGenerateSeed(seedPath)
	if err != nil {
		return nil, err
	}
	pub, err := paseto.NewV4AsymmetricPublicKeyFromEd25519(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	if err != nil {
		return nil, fmt.Errorf("voicetoken: public key: %w", err)
	}
	return NewVerifier(pub.ExportHex(), nodeID)
}

// Verify checks signature, required claims, TTL bounds, exp, iat skew,
// aud == nodeID and finally jti replay. The replay check runs last so a
// rejected token never burns a jti slot.
func (v *Verifier) Verify(token string) (*Claims, error) {
	t, err := paseto.NewParserWithoutExpiryCheck().ParseV4Public(v.pub, token, nil)
	if err != nil {
		return nil, fmt.Errorf("voicetoken: verify: %w", err)
	}
	var c Claims
	if c.IssuedAt, err = t.GetIssuedAt(); err != nil {
		return nil, fmt.Errorf("voicetoken: iat: %w", err)
	}
	if c.ExpiresAt, err = t.GetExpiration(); err != nil {
		return nil, fmt.Errorf("voicetoken: exp: %w", err)
	}
	if c.JTI, err = t.GetJti(); err != nil {
		return nil, fmt.Errorf("voicetoken: jti: %w", err)
	}
	if c.MediaNodeID, err = t.GetAudience(); err != nil {
		return nil, fmt.Errorf("voicetoken: aud: %w", err)
	}
	for _, f := range []struct {
		key string
		dst *string
	}{{"sessionId", &c.SessionID}, {"userId", &c.UserID}, {"guildId", &c.GuildID}, {"channelId", &c.ChannelID}} {
		if *f.dst, err = t.GetString(f.key); err != nil {
			return nil, fmt.Errorf("voicetoken: %s: %w", f.key, err)
		}
	}
	// Optional at this layer: a token from a gateway without device scope
	// reads as "". hachiman-media rejects that at identify.
	c.DeviceID, _ = t.GetString("deviceId")
	if err := c.validate(); err != nil {
		return nil, err
	}

	now := time.Now()
	if !now.Before(c.ExpiresAt) {
		return nil, ErrExpired
	}
	if now.Add(MaxClockSkew).Before(c.IssuedAt) {
		return nil, errors.New("voicetoken: token not yet valid")
	}
	if c.MediaNodeID != v.nodeID {
		return nil, fmt.Errorf("voicetoken: audience %q does not match node %q", c.MediaNodeID, v.nodeID)
	}
	if v.replay.SeenOrAdd(c.JTI, c.ExpiresAt) {
		return nil, errors.New("voicetoken: token replayed")
	}
	return &c, nil
}
