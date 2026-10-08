// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"hachiman/server/pkg/voicetoken"
)

const testNodeID = "media-us-east-1"

func newPair(t *testing.T) (*voicetoken.Signer, *voicetoken.Verifier) {
	t.Helper()
	s, err := voicetoken.NewSigner(filepath.Join(t.TempDir(), "keys", "voice-signer.ed25519"))
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	v, err := voicetoken.NewVerifier(s.PublicKeyHex(), testNodeID)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return s, v
}

func validClaims() voicetoken.Claims {
	now := time.Now().Truncate(time.Second)
	return voicetoken.Claims{
		SessionID:   "sess-abc",
		UserID:      "user-1",
		DeviceID:    "device-1",
		GuildID:     "guild-1",
		ChannelID:   "chan-1",
		MediaNodeID: testNodeID,
		JTI:         "jti-1",
		IssuedAt:    now,
		ExpiresAt:   now.Add(90 * time.Second),
	}
}

func TestMintVerifyRoundTrip(t *testing.T) {
	s, v := newPair(t)
	want := validClaims()
	tok, err := s.Mint(want)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	got, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.SessionID != want.SessionID || got.UserID != want.UserID || got.DeviceID != want.DeviceID || got.GuildID != want.GuildID ||
		got.ChannelID != want.ChannelID || got.MediaNodeID != want.MediaNodeID || got.JTI != want.JTI ||
		!got.IssuedAt.Equal(want.IssuedAt) || !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Errorf("claims mismatch:\n got %+v\nwant %+v", *got, want)
	}
}

// A token without a device id still verifies here; hachiman-media rejects it.
func TestDeviceIDOptional(t *testing.T) {
	s, v := newPair(t)
	c := validClaims()
	c.DeviceID = ""
	tok, err := s.Mint(c)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	got, err := v.Verify(tok)
	if err != nil || got.DeviceID != "" {
		t.Fatalf("Verify = %+v, %v; want empty deviceId", got, err)
	}
}

func TestMintFillsDefaults(t *testing.T) {
	s, v := newPair(t)
	c := validClaims()
	c.JTI, c.IssuedAt, c.ExpiresAt = "", time.Time{}, time.Time{}
	tok, err := s.Mint(c)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	got, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.JTI == "" || got.ExpiresAt.Sub(got.IssuedAt) != voicetoken.DefaultTTL {
		t.Errorf("defaults not applied: %+v", *got)
	}
}

func TestMintRejectsBadInput(t *testing.T) {
	s, _ := newPair(t)
	for name, mut := range map[string]func(*voicetoken.Claims){
		"ttl too short": func(c *voicetoken.Claims) { c.ExpiresAt = c.IssuedAt.Add(30 * time.Second) },
		"ttl too long":  func(c *voicetoken.Claims) { c.ExpiresAt = c.IssuedAt.Add(5 * time.Minute) },
		"no session":    func(c *voicetoken.Claims) { c.SessionID = "" },
		"no user":       func(c *voicetoken.Claims) { c.UserID = "" },
		"no channel":    func(c *voicetoken.Claims) { c.ChannelID = "" },
		"no aud":        func(c *voicetoken.Claims) { c.MediaNodeID = "" },
	} {
		c := validClaims()
		mut(&c)
		if _, err := s.Mint(c); err == nil {
			t.Errorf("%s: Mint succeeded, want error", name)
		}
	}
}

// A DM call has no guild: the token carries guildId "" (contract §7).
func TestMintVerifyDMCall(t *testing.T) {
	s, v := newPair(t)
	c := validClaims()
	c.GuildID = ""
	tok, err := s.Mint(c)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	got, err := v.Verify(tok)
	if err != nil || got.GuildID != "" || got.ChannelID != c.ChannelID {
		t.Fatalf("Verify = %+v, %v", got, err)
	}
}

func TestVerifyRejectsForeignAudience(t *testing.T) {
	s, v := newPair(t)
	c := validClaims()
	c.MediaNodeID = "media-eu-west-1"
	tok, err := s.Mint(c) // Signer mints for any aud
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := v.Verify(tok); err == nil || !strings.Contains(err.Error(), "audience") {
		t.Errorf("Verify foreign aud: err = %v, want audience error", err)
	}
}

func TestVerifyRejectsReplay(t *testing.T) {
	s, v := newPair(t)
	tok, _ := s.Mint(validClaims())
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("first Verify: %v", err)
	}
	if _, err := v.Verify(tok); err == nil || !strings.Contains(err.Error(), "replayed") {
		t.Errorf("second Verify: err = %v, want replay error", err)
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	s, v := newPair(t)
	c := validClaims()
	c.IssuedAt = time.Now().Add(-100 * time.Second)
	c.ExpiresAt = c.IssuedAt.Add(90 * time.Second)
	tok, _ := s.Mint(c)
	if _, err := v.Verify(tok); !errors.Is(err, voicetoken.ErrExpired) {
		t.Errorf("Verify expired: err = %v, want ErrExpired", err)
	}
}

func TestVerifyRejectsFutureIat(t *testing.T) {
	s, v := newPair(t)
	c := validClaims()
	c.IssuedAt = time.Now().Add(time.Hour)
	c.ExpiresAt = c.IssuedAt.Add(90 * time.Second)
	tok, _ := s.Mint(c)
	if _, err := v.Verify(tok); err == nil {
		t.Error("Verify future iat: want error")
	}
}

func TestVerifyRejectsOtherKeyAndTampering(t *testing.T) {
	s, v := newPair(t)
	other, _ := newPair(t)
	tok, _ := other.Mint(validClaims())
	if _, err := v.Verify(tok); err == nil {
		t.Error("Verify token from other key: want error")
	}
	tok, _ = s.Mint(validClaims())
	b := []byte(tok)
	i := len("v4.public.") + 5
	b[i] ^= 1
	if _, err := v.Verify(string(b)); err == nil {
		t.Error("Verify tampered token: want error")
	}
}

func TestVerifierFromSeedSharesKeyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "voice-signer.ed25519")
	v, err := voicetoken.NewVerifierFromSeed(path, testNodeID) // generates
	if err != nil {
		t.Fatalf("NewVerifierFromSeed: %v", err)
	}
	s, err := voicetoken.NewSigner(path) // reuses
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	tok, _ := s.Mint(validClaims())
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if fi, _ := os.Stat(path); fi.Size() != 32 || fi.Mode().Perm() != 0o600 {
		t.Errorf("keyfile size/mode = %d/%v", fi.Size(), fi.Mode().Perm())
	}
}

func TestNewSignerRejectsMalformedKeyfile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "k")
	if err := os.WriteFile(path, make([]byte, 16), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := voicetoken.NewSigner(path); err == nil {
		t.Error("NewSigner on 16-byte keyfile: want error")
	}
}

func TestNewVerifierRejectsBadInput(t *testing.T) {
	s, _ := newPair(t)
	if _, err := voicetoken.NewVerifier(s.PublicKeyHex(), ""); err == nil {
		t.Error("empty node id: want error")
	}
	if _, err := voicetoken.NewVerifier("zz", testNodeID); err == nil {
		t.Error("bad hex: want error")
	}
}

func TestReplayCacheRejectsDuplicate(t *testing.T) {
	c := voicetoken.NewReplayCache(8)
	exp := time.Now().Add(60 * time.Second)

	if c.SeenOrAdd("jti-1", exp) {
		t.Fatal("first SeenOrAdd reported duplicate")
	}
	if !c.SeenOrAdd("jti-1", exp) {
		t.Fatal("second SeenOrAdd missed duplicate")
	}
}

func TestReplayCacheEvictsBeyondCapacity(t *testing.T) {
	c := voicetoken.NewReplayCache(3)
	exp := time.Now().Add(60 * time.Second)

	for i := 0; i < 5; i++ {
		jti := string(rune('A' + i))
		if c.SeenOrAdd(jti, exp) {
			t.Fatalf("SeenOrAdd reported duplicate for fresh jti %q", jti)
		}
	}
	if c.Len() != 3 {
		t.Errorf("Len after 5 inserts into cap-3 cache: %d", c.Len())
	}
	// Oldest two ("A", "B") were evicted; re-inserting reports fresh.
	if c.SeenOrAdd("A", exp) {
		t.Error("evicted entry A reported as duplicate")
	}
}

func TestReplayCacheZeroCapacityAlwaysFresh(t *testing.T) {
	c := voicetoken.NewReplayCache(0)
	exp := time.Now().Add(time.Minute)
	for i := 0; i < 100; i++ {
		if c.SeenOrAdd("static-jti", exp) {
			t.Fatal("zero-capacity cache reported duplicate")
		}
	}
}

// TestReplayCacheDuplicateDoesNotPromote confirms that a duplicate hit does
// NOT lift the entry to MRU — otherwise an attacker could keep a known jti
// alive past its natural eviction by repeatedly re-presenting it, displacing
// legitimate older entries that are still within their TTL window.
func TestReplayCacheDuplicateDoesNotPromote(t *testing.T) {
	c := voicetoken.NewReplayCache(3)
	exp := time.Now().Add(60 * time.Second)

	// Insert A (back/oldest), B, C (front/newest).
	for _, j := range []string{"A", "B", "C"} {
		if c.SeenOrAdd(j, exp) {
			t.Fatalf("fresh jti %q reported duplicate", j)
		}
	}

	// Replay A a bunch — should report dup but NOT promote.
	for i := 0; i < 5; i++ {
		if !c.SeenOrAdd("A", exp) {
			t.Fatal("replayed A reported as fresh")
		}
	}

	// Now insert a fresh entry. Because A was NOT promoted, A is still the
	// oldest and gets evicted; re-inserting A reports fresh.
	if c.SeenOrAdd("D", exp) {
		t.Fatal("fresh D reported duplicate")
	}
	if c.SeenOrAdd("A", exp) {
		t.Error("A was promoted by duplicate replays (should have been evicted)")
	}
}

// TestReplayCacheEvictsExpiredEntries covers the explicit TTL-expiry eviction
// path of evictExpiredLocked.
func TestReplayCacheEvictsExpiredEntries(t *testing.T) {
	c := voicetoken.NewReplayCache(8)
	pastExp := time.Now().Add(-1 * time.Second)
	futureExp := time.Now().Add(60 * time.Second)

	if c.SeenOrAdd("expired-jti", pastExp) {
		t.Fatal("fresh insert of expired-jti reported duplicate")
	}
	// Trigger eviction sweep with an unrelated insert.
	if c.SeenOrAdd("fresh-jti", futureExp) {
		t.Fatal("fresh insert of fresh-jti reported duplicate")
	}
	if c.Len() != 1 {
		t.Errorf("Len after eviction: got %d, want 1", c.Len())
	}
	// expired-jti should now report fresh because it was evicted.
	if c.SeenOrAdd("expired-jti", futureExp) {
		t.Error("evicted expired-jti reported as duplicate")
	}
}

// TestFileSignerRejectsMalformedKeyfile covers refusal to start on a keyfile
// that isn't exactly 32 bytes — protects production material from being
