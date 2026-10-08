// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"aidanwoods.dev/go-paseto"
)

// DefaultKeyPath is the dev key file shared by gateway (Signer) and media
// (NewVerifierFromSeed).
const DefaultKeyPath = ".dev/keys/voice-signer.ed25519"

// Signer mints voice tokens for any media node (aud). Used by the gateway.
//
// ponytail: single key, no key id / rotation overlap. Add a footer key id and
// a trusted-key set on Verifier when rotation is needed.
type Signer struct {
	secret paseto.V4AsymmetricSecretKey
}

// NewSigner loads the raw 32-byte Ed25519 seed at seedPath, generating (and
// writing, 0600) a fresh one if the file doesn't exist. A file of the wrong
// size is an error rather than silently overwritten.
func NewSigner(seedPath string) (*Signer, error) {
	seed, err := loadOrGenerateSeed(seedPath)
	if err != nil {
		return nil, err
	}
	secret, err := paseto.NewV4AsymmetricSecretKeyFromEd25519(ed25519.NewKeyFromSeed(seed))
	if err != nil {
		return nil, fmt.Errorf("voicetoken: convert ed25519 key: %w", err)
	}
	return &Signer{secret: secret}, nil
}

// PublicKeyHex is the hex-encoded 32-byte Ed25519 public key, the value media
// takes via --voice-pubkey.
func (s *Signer) PublicKeyHex() string { return s.secret.Public().ExportHex() }

// Mint signs c. Zero-valued JTI / IssuedAt / ExpiresAt are filled with a
// random jti, now, and iat+DefaultTTL, so callers normally set only the ids.
func (s *Signer) Mint(c Claims) (string, error) {
	if c.JTI == "" {
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", fmt.Errorf("voicetoken: jti: %w", err)
		}
		c.JTI = hex.EncodeToString(b[:])
	}
	if c.IssuedAt.IsZero() {
		c.IssuedAt = time.Now()
	}
	if c.ExpiresAt.IsZero() {
		c.ExpiresAt = c.IssuedAt.Add(DefaultTTL)
	}
	if err := c.validate(); err != nil {
		return "", err
	}

	t := paseto.NewToken()
	t.SetIssuedAt(c.IssuedAt)
	t.SetExpiration(c.ExpiresAt)
	t.SetJti(c.JTI)
	t.SetAudience(c.MediaNodeID)
	t.SetString("sessionId", c.SessionID)
	t.SetString("userId", c.UserID)
	t.SetString("deviceId", c.DeviceID)
	t.SetString("guildId", c.GuildID)
	t.SetString("channelId", c.ChannelID)
	return t.V4Sign(s.secret, nil), nil
}

// validate checks required ids and the TTL window. guildId may be empty (a
// DM call). Shared by Mint and Verify so a token that mints always verifies
// (modulo time and replay).
func (c *Claims) validate() error {
	for _, f := range [][2]string{
		{"sessionId", c.SessionID}, {"userId", c.UserID},
		{"channelId", c.ChannelID}, {"aud", c.MediaNodeID}, {"jti", c.JTI},
	} {
		if f[1] == "" {
			return fmt.Errorf("voicetoken: %s required", f[0])
		}
	}
	if ttl := c.ExpiresAt.Sub(c.IssuedAt); ttl < MinTTL || ttl > MaxTTL {
		return fmt.Errorf("voicetoken: ttl %s outside [%s, %s]", ttl, MinTTL, MaxTTL)
	}
	return nil
}

func loadOrGenerateSeed(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("voicetoken: seed path required")
	}
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
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("voicetoken: mkdir keyfile parent: %w", err)
		}
		// O_EXCL: if gateway and media race to create the dev key, the loser
		// re-reads the winner's seed instead of clobbering it.
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			return loadOrGenerateSeed(path)
		}
		if err != nil {
			return nil, fmt.Errorf("voicetoken: create keyfile: %w", err)
		}
		defer f.Close()
		if _, err := f.Write(seed); err != nil {
			return nil, fmt.Errorf("voicetoken: write keyfile: %w", err)
		}
		return seed, nil
	default:
		return nil, fmt.Errorf("voicetoken: read keyfile %q: %w", path, err)
	}
}
