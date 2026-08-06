// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken

// Signer abstracts the keying material behind token minting and verification.
//
// The interface is HIGH-LEVEL (MintToken / VerifyToken) rather than low-level
// (Sign / Verify raw bytes) for one pragmatic reason: PASETO v4.public does
// the Ed25519 sign internally on a pre-auth-encoded payload it computes
// itself, and the upstream go-paseto library does not expose a hook for a
// custom signer. Wrapping at the token-mint level keeps the interface
// composable without forking PASETO. A future AWS-KMS-backed Signer will have
// to implement PASETO encode/decode itself, or the project will switch to a
// format that does compose with KMS Sign — that is a phase-3 decision tracked
// in the migration doc, not this file.
//
// Implementations of this interface:
//   - FileSigner (signer_file.go): persists an Ed25519 keypair on disk; used
//     by dev and by embedded-mode self-hosters. Generates a fresh key on
//     first boot.
//   - KMSSigner (deferred, phase 3): AWS KMS-backed.
//
// Rotation: ActiveKeyIDs returns the currently-trusted key set (>=1 entry).
// During the two-key overlap window for a 90-day rotation, both keys are
// trusted for verify; only one is active for mint.
type Signer interface {
	// MintToken signs the claims and returns the PASETO token string. The
	// active signing key is selected by the Signer; callers don't pick.
	MintToken(claims Claims) (string, error)

	// VerifyToken parses and validates a token. It returns the claims on
	// success. Validates: signature against ANY active key id, exp within
	// the allowed TTL window, iat ≤ now + MaxClockSkew, exp > now, audience
	// (`aud` / MediaNodeID) equals the Signer's bound node id, and presence
	// of all required string claims (session_id, user_id, dtls_fingerprint,
	// ice_ufrag). It does NOT validate the DTLS-fingerprint binding (that
	// happens in media at DTLS handshake time against the OpenSession
	// context) or the JTI replay (separate ReplayCache; verify is stateless).
	VerifyToken(token string) (*Claims, error)

	// ActiveKeyIDs returns identifiers for every key the Signer will accept
	// at Verify time. The list ALWAYS includes the current mint key; during
	// rotation it ALSO includes the previous key for the overlap window.
	// Order is stable; first entry is the current mint key.
	ActiveKeyIDs() []string
}
