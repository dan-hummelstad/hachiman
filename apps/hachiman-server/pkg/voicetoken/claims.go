// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Package voicetoken mints and verifies the short-lived signed tokens that
// authorize a client's WebRTC session against a media node.
//
// Wire format: PASETO v4.public (Ed25519 asymmetric, JSON inner payload).
// Picked over JWT for the no-alg-confusion guarantee and over custom CBOR for
// industry-recognizability. See MEDIA-PLANE-MIGRATION.md Phase 1 step 4.
//
// Flow (per the rev-6 architectural call "voice token reaches media via
// sidechannel ExpectedSession push"):
//   1. Client computes its DTLS fingerprint after RTCPeerConnection creation.
//   2. Client sends VoiceTokenRequest{dtls_fingerprint, ice_ufrag} to control.
//   3. Control mints a token binding the fingerprint into the claim.
//   4. Control sends VoiceTokenGrant{token, media_node_addr, …} back to the
//      client AND pushes OpenSession{token, …} to the assigned media node
//      over the sidechannel.
//   5. Client opens its RTCPeerConnection to the media node. When the DTLS
//      handshake arrives, media looks up the expected fingerprint from the
//      pushed OpenSession and rejects on mismatch — DTLS-layer defence
//      against a leaked token replayed from a different peer.
//
// Token TTL is short (60–120s). Mid-call refresh extends it via a fresh
// VoiceTokenGrant pushed over the existing client control channel; media
// accepts the new token without WebRTC renegotiation since the only
// session-bound material (DTLS fingerprint, ICE ufrag) doesn't change.
//
// Replay protection: media keeps a bounded LRU of seen JTIs for the TTL
// window; duplicates rejected.

package voicetoken

import "time"

// Claims is the structured payload carried inside a PASETO v4.public token.
//
// Field names mirror the spec in MEDIA-PLANE-MIGRATION.md Phase 1 step 4 and
// are serialized as snake_case keys in the JSON inner payload.
type Claims struct {
	// SessionID — control-side unique session identifier. Media uses this as
	// the lookup key for the pre-pushed OpenSession state.
	SessionID string `json:"session_id"`

	// UserID — opaque user identifier (PII rule: NOT username/email).
	UserID string `json:"user_id"`

	// ChannelID — Mumble-side channel the session is opening into. Media
	// doesn't dereference; it's an opaque correlation id.
	ChannelID uint64 `json:"channel_id"`

	// MediaNodeID — the audience (`aud`) binding. Token signed for one
	// specific media node; replay against a different node is rejected.
	MediaNodeID string `json:"media_node_id"`

	// QualityProfileID — which codec/ladder/jitter profile applies.
	QualityProfileID uint64 `json:"quality_profile_id"`

	// VoiceTargets — pre-resolved whisper target session IDs (control
	// pre-computes; media's matrix is a static map).
	VoiceTargets []uint32 `json:"voice_targets,omitempty"`

	// SSRC — allocated by control at mint time, embedded in the token
	// (resolves the SSRC-ownership question across the split).
	SSRC uint32 `json:"ssrc"`

	// DTLSFingerprint — client's WebRTC certificate fingerprint, including
	// algorithm prefix ("sha-256 ..."). Critical: media rejects any DTLS
	// handshake whose cert fingerprint doesn't match.
	DTLSFingerprint string `json:"dtls_fingerprint"`

	// ICEUfrag — client's ICE ufrag committed at PC creation.
	ICEUfrag string `json:"ice_ufrag"`

	// JTI — unique nonce for replay protection.
	JTI string `json:"jti"`

	// IssuedAt / ExpiresAt — PASETO carries these as standard claims (`iat`,
	// `exp`); we mirror them in the struct for ergonomic access.
	IssuedAt  time.Time `json:"iat"`
	ExpiresAt time.Time `json:"exp"`
}

// MinTTL / MaxTTL bound the allowed token validity window per the spec.
// Mint rejects requests outside these bounds; verify rejects tokens whose
// (exp - iat) sits outside them.
//
// MaxClockSkew is the tolerated forward-skew on iat between control and media.
// VerifyToken rejects tokens whose iat sits more than MaxClockSkew in the
// future (defends against a misconfigured mint side; benign drift is absorbed).
const (
	MinTTL       = 60 * time.Second
	MaxTTL       = 120 * time.Second
	MaxClockSkew = 30 * time.Second
)
