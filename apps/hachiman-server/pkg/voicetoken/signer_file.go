// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"aidanwoods.dev/go-paseto"
)

// FileSigner persists an Ed25519 keypair as a 32-byte seed on disk.
//
// Wire format on disk: raw 32-byte seed, mode 0600. NOT PEM, NOT base64 —
// flat seed bytes. Trivially regenerable from the seed via Ed25519.NewKeyFromSeed.
//
// Used by:
//   - dev: keyfile lives under .dev/keys/voice-signer.ed25519
//   - embedded mode (self-host): keyfile in the data dir alongside murmur.sqlite
//   - tests: in-memory variant via NewFileSignerInMemory
//
// Key id is the lowercase hex SHA-256 of the public-key bytes truncated to 16
// hex chars (8 bytes). Stable across process restarts. Used as the
// PASETO footer so VerifyToken can pick the right key during a two-key
// overlap window.
type FileSigner struct {
	// nodeID is the local media node identifier. VerifyToken rejects any
	// token whose audience (`aud` / MediaNodeID claim) doesn't match — i.e.
	// audience binding is enforced inside the package, not at the call site.
	nodeID string

	mu     sync.RWMutex
	active paseto.V4AsymmetricSecretKey
	// trusted maps key id → public key. Always includes the active key's
	// public; during rotation, also includes the predecessor.
	trusted     map[string]paseto.V4AsymmetricPublicKey
	activeKeyID string
	// keyIDs is ActiveKeyIDs() output, cached in stable order (active first).
	keyIDs []string
}

// NewFileSigner loads or generates a keypair at the given path and binds the
// signer to a media-node identity.
//
// nodeID is the local media node id. It is BOTH:
//   - written into the `aud` claim at mint time (claims.MediaNodeID is verified
//     to match before signing), AND
//   - checked at verify time — VerifyToken rejects any token whose audience
//     doesn't equal this node id. This makes cross-node token replay impossible
//     even if the foreign node's signing key is in the trusted set.
//
// If the file does not exist, generates a fresh 32-byte seed via crypto/rand
// and writes it. If it exists, reads and parses; refuses to start on a
// malformed (non-32-byte) file rather than overwriting potentially-active
// production material.
//
// The path's parent directory must exist; NewFileSigner does NOT mkdir.
func NewFileSigner(path, nodeID string) (*FileSigner, error) {
	if path == "" {
		return nil, errors.New("voicetoken: file signer path required")
	}
	if nodeID == "" {
		return nil, errors.New("voicetoken: node id required")
	}

	seed, err := loadOrGenerateSeed(path)
	if err != nil {
		return nil, err
	}

	priv := ed25519.NewKeyFromSeed(seed)
	pasetoSecret, err := paseto.NewV4AsymmetricSecretKeyFromEd25519(priv)
	if err != nil {
		return nil, fmt.Errorf("voicetoken: convert ed25519 → paseto: %w", err)
	}
	pasetoPublic := pasetoSecret.Public()

	keyID := computeKeyID(priv.Public().(ed25519.PublicKey))

	return &FileSigner{
		nodeID:      nodeID,
		active:      pasetoSecret,
		activeKeyID: keyID,
		trusted:     map[string]paseto.V4AsymmetricPublicKey{keyID: pasetoPublic},
		keyIDs:      []string{keyID},
	}, nil
}

// TrustAdditionalKey adds a public key to the trusted set without making it
// active. Used during signing-key rotation: the new active key is loaded
// first, then the previous active key is registered as additional trust for
// the overlap window. Tokens minted before rotation continue to verify until
// they expire naturally.
func (f *FileSigner) TrustAdditionalKey(keyID string, pub ed25519.PublicKey) error {
	if keyID == "" {
		return errors.New("voicetoken: empty key id")
	}
	pasetoPublic, err := paseto.NewV4AsymmetricPublicKeyFromEd25519(pub)
	if err != nil {
		return fmt.Errorf("voicetoken: convert pubkey → paseto: %w", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.trusted[keyID]; exists {
		return nil
	}
	f.trusted[keyID] = pasetoPublic
	f.keyIDs = append(f.keyIDs, keyID)
	return nil
}

// MintToken implements Signer.
func (f *FileSigner) MintToken(claims Claims) (string, error) {
	if err := validateMintInputs(claims); err != nil {
		return "", err
	}
	if claims.MediaNodeID != f.nodeID {
		return "", fmt.Errorf("voicetoken: media_node_id %q does not match signer node %q",
			claims.MediaNodeID, f.nodeID)
	}

	t := paseto.NewToken()
	t.SetIssuedAt(claims.IssuedAt)
	t.SetExpiration(claims.ExpiresAt)
	t.SetJti(claims.JTI)
	t.SetAudience(claims.MediaNodeID)

	t.SetString("session_id", claims.SessionID)
	t.SetString("user_id", claims.UserID)
	if err := t.Set("channel_id", claims.ChannelID); err != nil {
		return "", err
	}
	if err := t.Set("quality_profile_id", claims.QualityProfileID); err != nil {
		return "", err
	}
	if len(claims.VoiceTargets) > 0 {
		if err := t.Set("voice_targets", claims.VoiceTargets); err != nil {
			return "", err
		}
	}
	if err := t.Set("ssrc", claims.SSRC); err != nil {
		return "", err
	}
	t.SetString("dtls_fingerprint", claims.DTLSFingerprint)
	t.SetString("ice_ufrag", claims.ICEUfrag)

	f.mu.RLock()
	defer f.mu.RUnlock()
	// Footer carries the active key id so Verify can pick which trusted key
	// to validate against. PASETO footers are AUTHENTICATED but not encrypted
	// — perfect for key-id routing.
	t.SetFooter([]byte(f.activeKeyID))

	return t.V4Sign(f.active, nil), nil
}

// VerifyToken implements Signer.
func (f *FileSigner) VerifyToken(token string) (*Claims, error) {
	// Read footer (key id) without trusting it cryptographically — the
	// signature check below proves the key id was authenticated.
	parser := paseto.NewParserWithoutExpiryCheck() // we enforce TTL ourselves
	footer, err := parser.UnsafeParseFooter(paseto.V4Public, token)
	if err != nil {
		return nil, fmt.Errorf("voicetoken: parse footer: %w", err)
	}
	keyID := string(footer)

	f.mu.RLock()
	pub, ok := f.trusted[keyID]
	f.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("voicetoken: unknown key id %q", keyID)
	}

	parsed, err := parser.ParseV4Public(pub, token, nil)
	if err != nil {
		return nil, fmt.Errorf("voicetoken: verify signature: %w", err)
	}

	claims, err := extractClaims(parsed)
	if err != nil {
		return nil, err
	}
	// Audience binding is enforced inside the package: a token minted for a
	// different media node is rejected even if its signing key is trusted.
	if claims.MediaNodeID != f.nodeID {
		return nil, fmt.Errorf("voicetoken: audience %q does not match node %q",
			claims.MediaNodeID, f.nodeID)
	}
	return claims, nil
}

// ActiveKeyIDs implements Signer.
func (f *FileSigner) ActiveKeyIDs() []string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make([]string, len(f.keyIDs))
	copy(out, f.keyIDs)
	return out
}

func loadOrGenerateSeed(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(data) != ed25519.SeedSize {
			return nil, fmt.Errorf("voicetoken: keyfile %q is %d bytes, want %d", path, len(data), ed25519.SeedSize)
		}
		return data, nil
	case errors.Is(err, os.ErrNotExist):
		seed := make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return nil, fmt.Errorf("voicetoken: generate seed: %w", err)
		}
		// Ensure parent dir exists in a permissive way — caller is supposed
		// to have created it, but a missing leaf is a common dev mistake.
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("voicetoken: mkdir keyfile parent: %w", err)
		}
		if err := os.WriteFile(path, seed, 0o600); err != nil {
			return nil, fmt.Errorf("voicetoken: write keyfile: %w", err)
		}
		return seed, nil
	default:
		return nil, fmt.Errorf("voicetoken: read keyfile %q: %w", path, err)
	}
}

func computeKeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

func validateMintInputs(c Claims) error {
	if c.SessionID == "" {
		return errors.New("voicetoken: session_id required")
	}
	if c.MediaNodeID == "" {
		return errors.New("voicetoken: media_node_id required")
	}
	if c.DTLSFingerprint == "" {
		return errors.New("voicetoken: dtls_fingerprint required")
	}
	if c.JTI == "" {
		return errors.New("voicetoken: jti required")
	}
	if c.IssuedAt.IsZero() || c.ExpiresAt.IsZero() {
		return errors.New("voicetoken: iat and exp required")
	}
	ttl := c.ExpiresAt.Sub(c.IssuedAt)
	if ttl < MinTTL || ttl > MaxTTL {
		return fmt.Errorf("voicetoken: ttl %s outside [%s, %s]", ttl, MinTTL, MaxTTL)
	}
	return nil
}

func extractClaims(t *paseto.Token) (*Claims, error) {
	var c Claims

	iat, err := t.GetIssuedAt()
	if err != nil {
		return nil, fmt.Errorf("voicetoken: iat: %w", err)
	}
	c.IssuedAt = iat
	exp, err := t.GetExpiration()
	if err != nil {
		return nil, fmt.Errorf("voicetoken: exp: %w", err)
	}
	c.ExpiresAt = exp

	// Reject tokens with absurd TTL even if they verify cryptographically —
	// belt and braces against a misconfigured mint side.
	ttl := exp.Sub(iat)
	if ttl < MinTTL || ttl > MaxTTL {
		return nil, fmt.Errorf("voicetoken: ttl %s outside [%s, %s]", ttl, MinTTL, MaxTTL)
	}
	now := time.Now()
	if now.After(exp) {
		return nil, errors.New("voicetoken: token expired")
	}
	// Defend against a mis-clocked mint side: tokens issued meaningfully in
	// the future are rejected. MaxClockSkew absorbs benign drift.
	if now.Add(MaxClockSkew).Before(iat) {
		return nil, errors.New("voicetoken: token not yet valid")
	}

	jti, err := t.GetJti()
	if err != nil {
		return nil, fmt.Errorf("voicetoken: jti: %w", err)
	}
	c.JTI = jti

	aud, err := t.GetAudience()
	if err != nil {
		return nil, fmt.Errorf("voicetoken: aud: %w", err)
	}
	c.MediaNodeID = aud

	// Required string claims. These are populated unconditionally at mint
	// time, so a missing entry here means a tampered or alien token.
	for _, rc := range []struct {
		name string
		dst  *string
	}{
		{"session_id", &c.SessionID},
		{"user_id", &c.UserID},
		{"dtls_fingerprint", &c.DTLSFingerprint},
		{"ice_ufrag", &c.ICEUfrag},
	} {
		v, err := t.GetString(rc.name)
		if err != nil {
			return nil, fmt.Errorf("voicetoken: %s: %w", rc.name, err)
		}
		if v == "" {
			return nil, fmt.Errorf("voicetoken: %s required", rc.name)
		}
		*rc.dst = v
	}

	if err := t.Get("channel_id", &c.ChannelID); err != nil {
		return nil, fmt.Errorf("voicetoken: channel_id: %w", err)
	}
	if err := t.Get("quality_profile_id", &c.QualityProfileID); err != nil {
		return nil, fmt.Errorf("voicetoken: quality_profile_id: %w", err)
	}
	if err := t.Get("ssrc", &c.SSRC); err != nil {
		return nil, fmt.Errorf("voicetoken: ssrc: %w", err)
	}
	// voice_targets is optional; ignore decode errors when the key isn't set.
	_ = t.Get("voice_targets", &c.VoiceTargets)

	return &c, nil
}
