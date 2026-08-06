// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"mumble.info/grumble/pkg/voicetoken"
)

// testNodeID is the audience all helper-built signers/claims bind to. Tests
// that exercise cross-node rejection construct their own signers explicitly.
const testNodeID = "media-us-east-1"

func mustNewFileSigner(t *testing.T) *voicetoken.FileSigner {
	t.Helper()
	dir := t.TempDir()
	s, err := voicetoken.NewFileSigner(filepath.Join(dir, "voice-signer.ed25519"), testNodeID)
	if err != nil {
		t.Fatalf("NewFileSigner: %v", err)
	}
	return s
}

// mustNewFileSignerWithSeed builds a deterministic signer from a fixed 32-byte
// seed. Used by the rotation overlap test that needs to know A's pubkey ahead
// of time to register it as additional trust on B.
func mustNewFileSignerWithSeed(t *testing.T, seed []byte) (*voicetoken.FileSigner, ed25519.PublicKey) {
	t.Helper()
	return mustNewFileSignerWithSeedAndNode(t, seed, testNodeID)
}

func mustNewFileSignerWithSeedAndNode(t *testing.T, seed []byte, nodeID string) (*voicetoken.FileSigner, ed25519.PublicKey) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "voice-signer.ed25519")
	if err := os.WriteFile(path, seed, 0o600); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	s, err := voicetoken.NewFileSigner(path, nodeID)
	if err != nil {
		t.Fatalf("NewFileSigner: %v", err)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	return s, priv.Public().(ed25519.PublicKey)
}

func computeKeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

func validClaims() voicetoken.Claims {
	now := time.Now().Truncate(time.Second)
	return voicetoken.Claims{
		SessionID:        "sess-abc123",
		UserID:           "user-opaque-7",
		ChannelID:        42,
		MediaNodeID:      "media-us-east-1",
		QualityProfileID: 1,
		SSRC:             1234567,
		DTLSFingerprint:  "sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
		ICEUfrag:         "abcd",
		JTI:              "11111111-2222-3333-4444-555555555555",
		IssuedAt:         now,
		ExpiresAt:        now.Add(90 * time.Second),
	}
}

func TestMintAndVerifyRoundTrip(t *testing.T) {
	s := mustNewFileSigner(t)
	in := validClaims()

	tok, err := s.MintToken(in)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if !strings.HasPrefix(tok, "v4.public.") {
		t.Fatalf("token doesn't have v4.public prefix: %q", tok)
	}

	out, err := s.VerifyToken(tok)
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}

	if out.SessionID != in.SessionID {
		t.Errorf("SessionID: got %q want %q", out.SessionID, in.SessionID)
	}
	if out.UserID != in.UserID {
		t.Errorf("UserID: got %q want %q", out.UserID, in.UserID)
	}
	if out.ChannelID != in.ChannelID {
		t.Errorf("ChannelID: got %d want %d", out.ChannelID, in.ChannelID)
	}
	if out.MediaNodeID != in.MediaNodeID {
		t.Errorf("MediaNodeID: got %q want %q", out.MediaNodeID, in.MediaNodeID)
	}
	if out.QualityProfileID != in.QualityProfileID {
		t.Errorf("QualityProfileID: got %d want %d", out.QualityProfileID, in.QualityProfileID)
	}
	if out.SSRC != in.SSRC {
		t.Errorf("SSRC: got %d want %d", out.SSRC, in.SSRC)
	}
	if out.DTLSFingerprint != in.DTLSFingerprint {
		t.Errorf("DTLSFingerprint mismatch")
	}
	if out.ICEUfrag != in.ICEUfrag {
		t.Errorf("ICEUfrag mismatch")
	}
	if out.JTI != in.JTI {
		t.Errorf("JTI mismatch")
	}
	if !out.IssuedAt.Equal(in.IssuedAt) {
		t.Errorf("IssuedAt: got %v want %v", out.IssuedAt, in.IssuedAt)
	}
	if !out.ExpiresAt.Equal(in.ExpiresAt) {
		t.Errorf("ExpiresAt: got %v want %v", out.ExpiresAt, in.ExpiresAt)
	}
}

func TestVoiceTargetsRoundTrip(t *testing.T) {
	s := mustNewFileSigner(t)
	in := validClaims()
	in.VoiceTargets = []uint32{10, 20, 30}

	tok, err := s.MintToken(in)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	out, err := s.VerifyToken(tok)
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if len(out.VoiceTargets) != 3 || out.VoiceTargets[0] != 10 || out.VoiceTargets[2] != 30 {
		t.Errorf("VoiceTargets round-trip wrong: %v", out.VoiceTargets)
	}
}

func TestMintRejectsTTLOutOfBounds(t *testing.T) {
	s := mustNewFileSigner(t)

	tooShort := validClaims()
	tooShort.ExpiresAt = tooShort.IssuedAt.Add(30 * time.Second) // < MinTTL=60s
	if _, err := s.MintToken(tooShort); err == nil {
		t.Error("MintToken accepted TTL below MinTTL")
	}

	tooLong := validClaims()
	tooLong.ExpiresAt = tooLong.IssuedAt.Add(300 * time.Second) // > MaxTTL=120s
	if _, err := s.MintToken(tooLong); err == nil {
		t.Error("MintToken accepted TTL above MaxTTL")
	}
}

func TestMintRejectsMissingRequiredFields(t *testing.T) {
	s := mustNewFileSigner(t)

	for _, tc := range []struct {
		name string
		mut  func(*voicetoken.Claims)
	}{
		{"no session_id", func(c *voicetoken.Claims) { c.SessionID = "" }},
		{"no media_node_id", func(c *voicetoken.Claims) { c.MediaNodeID = "" }},
		{"no dtls_fingerprint", func(c *voicetoken.Claims) { c.DTLSFingerprint = "" }},
		{"no jti", func(c *voicetoken.Claims) { c.JTI = "" }},
		{"no iat", func(c *voicetoken.Claims) { c.IssuedAt = time.Time{} }},
		{"no exp", func(c *voicetoken.Claims) { c.ExpiresAt = time.Time{} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := validClaims()
			tc.mut(&c)
			if _, err := s.MintToken(c); err == nil {
				t.Errorf("MintToken accepted invalid claims (%s)", tc.name)
			}
		})
	}
}

func TestVerifyRejectsTampering(t *testing.T) {
	s := mustNewFileSigner(t)
	tok, err := s.MintToken(validClaims())
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}

	// Flip a byte in the middle of the encoded payload.
	parts := strings.Split(tok, ".")
	if len(parts) < 3 {
		t.Fatalf("unexpected token shape: %q", tok)
	}
	payload := []byte(parts[2])
	if len(payload) > 4 {
		payload[4] ^= 0x01
	}
	parts[2] = string(payload)
	tampered := strings.Join(parts, ".")
	if _, err := s.VerifyToken(tampered); err == nil {
		t.Error("VerifyToken accepted tampered payload")
	}
}

func TestVerifyRejectsUnknownKey(t *testing.T) {
	// Mint with signer A, try to verify with signer B (different key dir).
	a := mustNewFileSigner(t)
	tok, err := a.MintToken(validClaims())
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	b := mustNewFileSigner(t)
	if _, err := b.VerifyToken(tok); err == nil {
		t.Error("VerifyToken accepted token signed by foreign signer")
	}
}

func TestVerifyAcceptsAdditionalTrustedKey(t *testing.T) {
	// Simulate the rotation overlap window: signer B issues new tokens, but
	// signer A's public key is registered as additional trust so A's tokens
	// continue to verify until they expire naturally.
	seedA := make([]byte, ed25519.SeedSize)
	seedB := make([]byte, ed25519.SeedSize)
	for i := range seedA {
		seedA[i] = 0xAA
		seedB[i] = 0xBB
	}

	sA, pubA := mustNewFileSignerWithSeed(t, seedA)
	sB, _ := mustNewFileSignerWithSeed(t, seedB)
	kidA := computeKeyID(pubA)

	tok, err := sA.MintToken(validClaims())
	if err != nil {
		t.Fatalf("sA.MintToken: %v", err)
	}

	// sB doesn't trust A yet.
	if _, err := sB.VerifyToken(tok); err == nil {
		t.Error("sB verified A's token without trusting A")
	}

	if err := sB.TrustAdditionalKey(kidA, pubA); err != nil {
		t.Fatalf("TrustAdditionalKey: %v", err)
	}
	if _, err := sB.VerifyToken(tok); err != nil {
		t.Errorf("sB rejected A's token even after trust: %v", err)
	}

	ids := sB.ActiveKeyIDs()
	if len(ids) != 2 {
		t.Errorf("ActiveKeyIDs after rotation: got %d, want 2 (%v)", len(ids), ids)
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
// silently overwritten by a fresh seed.
func TestFileSignerRejectsMalformedKeyfile(t *testing.T) {
	for _, sz := range []int{16, 64} {
		t.Run(strconv.Itoa(sz), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "voice-signer.ed25519")
			if err := os.WriteFile(path, make([]byte, sz), 0o600); err != nil {
				t.Fatalf("write malformed keyfile: %v", err)
			}
			_, err := voicetoken.NewFileSigner(path, testNodeID)
			if err == nil {
				t.Fatalf("NewFileSigner accepted %d-byte keyfile", sz)
			}
			if !strings.Contains(err.Error(), "bytes, want 32") {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

// TestFileSignerPersistsAcrossReopen verifies that two FileSigners constructed
// against the same keyfile path share signing identity — i.e. a restart
// preserves outstanding tokens' verifiability.
func TestFileSignerPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "voice-signer.ed25519")

	a, err := voicetoken.NewFileSigner(path, testNodeID)
	if err != nil {
		t.Fatalf("NewFileSigner A: %v", err)
	}
	tok, err := a.MintToken(validClaims())
	if err != nil {
		t.Fatalf("a.MintToken: %v", err)
	}

	b, err := voicetoken.NewFileSigner(path, testNodeID)
	if err != nil {
		t.Fatalf("NewFileSigner B: %v", err)
	}
	if _, err := b.VerifyToken(tok); err != nil {
		t.Fatalf("b.VerifyToken after reopen: %v", err)
	}

	idsA := a.ActiveKeyIDs()
	idsB := b.ActiveKeyIDs()
	if len(idsA) == 0 || len(idsB) == 0 || idsA[0] != idsB[0] {
		t.Errorf("active key id changed across reopen: A=%v B=%v", idsA, idsB)
	}
}

// TestVerifyRejectsForeignAudience confirms the package-level audience-binding
// fix (finding #6): a token minted for node A is rejected by node B even when
// B trusts A's signing key.
func TestVerifyRejectsForeignAudience(t *testing.T) {
	seedA := make([]byte, ed25519.SeedSize)
	seedB := make([]byte, ed25519.SeedSize)
	for i := range seedA {
		seedA[i] = 0xAA
		seedB[i] = 0xBB
	}

	sA, pubA := mustNewFileSignerWithSeedAndNode(t, seedA, "node-A")
	sB, _ := mustNewFileSignerWithSeedAndNode(t, seedB, "node-B")
	kidA := computeKeyID(pubA)

	in := validClaims()
	in.MediaNodeID = "node-A"
	tok, err := sA.MintToken(in)
	if err != nil {
		t.Fatalf("sA.MintToken: %v", err)
	}

	if err := sB.TrustAdditionalKey(kidA, pubA); err != nil {
		t.Fatalf("TrustAdditionalKey: %v", err)
	}
	// Signature verifies (A's key is trusted), but audience binds to node-A
	// and B should reject regardless.
	_, err = sB.VerifyToken(tok)
	if err == nil {
		t.Fatal("sB accepted token minted for node-A")
	}
	if !strings.Contains(err.Error(), "audience") {
		t.Errorf("expected audience rejection, got: %v", err)
	}
}

// TestMintRejectsForeignAudience covers the symmetric mint-side guard: callers
// can't accidentally hand the signer a token for someone else's audience.
func TestMintRejectsForeignAudience(t *testing.T) {
	s := mustNewFileSigner(t)
	in := validClaims()
	in.MediaNodeID = "some-other-node"
	if _, err := s.MintToken(in); err == nil {
		t.Error("MintToken accepted claim for foreign media_node_id")
	}
}

// TestVerifyRejectsFooterSwap covers finding #18: an attacker who controls the
// raw token bytes can't swap the key-id footer to point at a different trusted
// key, because PASETO authenticates the footer in the signature.
func TestVerifyRejectsFooterSwap(t *testing.T) {
	seedA := make([]byte, ed25519.SeedSize)
	seedB := make([]byte, ed25519.SeedSize)
	for i := range seedA {
		seedA[i] = 0xCC
		seedB[i] = 0xDD
	}

	sA, pubA := mustNewFileSignerWithSeed(t, seedA)
	sB, pubB := mustNewFileSignerWithSeed(t, seedB)
	kidA := computeKeyID(pubA)
	kidB := computeKeyID(pubB)

	// sB trusts A as additional, so it has both kids in its set.
	if err := sB.TrustAdditionalKey(kidA, pubA); err != nil {
		t.Fatalf("TrustAdditionalKey: %v", err)
	}

	tok, err := sA.MintToken(validClaims())
	if err != nil {
		t.Fatalf("sA.MintToken: %v", err)
	}

	parts := strings.Split(tok, ".")
	if len(parts) != 4 {
		t.Fatalf("expected v4.public.<payload>.<footer> shape, got %d parts", len(parts))
	}
	// Swap A's footer for B's key id, base64url-unpadded encoded the same
	// way the original was (raw hex bytes round-trip cleanly through PASETO's
	// b64 footer).
	swapped := encodeFooterToB64(kidB)
	parts[3] = swapped
	tampered := strings.Join(parts, ".")

	if _, err := sB.VerifyToken(tampered); err == nil {
		t.Error("VerifyToken accepted token with swapped footer")
	}
}

// encodeFooterToB64 produces the base64url-unpadded form PASETO uses for the
// footer segment. The PASETO footer is the raw bytes of the key id string.
func encodeFooterToB64(footer string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(footer))
}

// TestTrustAdditionalKeyIdempotent covers finding #19: calling TrustAdditionalKey
// twice with the same key id is a no-op on the active set.
func TestTrustAdditionalKeyIdempotent(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = 0xEE
	}
	_, pub := mustNewFileSignerWithSeed(t, seed)
	kid := computeKeyID(pub)

	s := mustNewFileSigner(t)
	before := len(s.ActiveKeyIDs())
	if err := s.TrustAdditionalKey(kid, pub); err != nil {
		t.Fatalf("TrustAdditionalKey first: %v", err)
	}
	afterFirst := len(s.ActiveKeyIDs())
	if afterFirst != before+1 {
		t.Fatalf("first trust didn't add: got %d want %d", afterFirst, before+1)
	}
	if err := s.TrustAdditionalKey(kid, pub); err != nil {
		t.Fatalf("TrustAdditionalKey second: %v", err)
	}
	if got := len(s.ActiveKeyIDs()); got != afterFirst {
		t.Errorf("ActiveKeyIDs grew on duplicate trust: got %d want %d", got, afterFirst)
	}
}

// TestTrustAdditionalKeyRejectsEmptyKeyID covers the explicit empty-id guard.
func TestTrustAdditionalKeyRejectsEmptyKeyID(t *testing.T) {
	s := mustNewFileSigner(t)
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = 0xFF
	}
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	if err := s.TrustAdditionalKey("", pub); err == nil {
		t.Error("TrustAdditionalKey accepted empty key id")
	}
}

// TestVerifyRejectsExpiredToken covers finding #20: tokens whose exp is in the
// past are rejected at verify time even if the signature is valid.
func TestVerifyRejectsExpiredToken(t *testing.T) {
	s := mustNewFileSigner(t)
	in := validClaims()
	now := time.Now().Truncate(time.Second)
	// IssuedAt 180s ago, ExpiresAt 90s ago. TTL = 90s, within [60s, 120s]
	// so MintToken accepts. VerifyToken should still reject for being expired.
	in.IssuedAt = now.Add(-180 * time.Second)
	in.ExpiresAt = now.Add(-90 * time.Second)

	tok, err := s.MintToken(in)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	_, err = s.VerifyToken(tok)
	if err == nil {
		t.Fatal("VerifyToken accepted expired token")
	}
	if !strings.Contains(err.Error(), "expired") {
		t.Errorf("expected 'expired' in error, got: %v", err)
	}
}
