// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package coturn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// knownTime is the fixed reference time tests use so the minted username's
// expiry component is deterministic. 2026-06-07T12:00:00Z — within the time
// window when phase 3a landed, easy to spot in test failure output.
var knownTime = time.Date(2026, time.June, 7, 12, 0, 0, 0, time.UTC)

// TestMintICEServers_Deterministic locks in that the minted username +
// credential are pure functions of (region secret, ttl, user, now). This is
// the contract media nodes (in production: coturn's authenticator) verify
// against, so a bug here means voice silently falls back to host-only ICE.
func TestMintICEServers_Deterministic(t *testing.T) {
	t.Parallel()
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{
				Region:        "us-east",
				Endpoints:     []string{"turn:turn.us-east.example.com:3478?transport=udp"},
				HMACSecret:    "super-secret-shared-key",
				CredentialTTL: 5 * time.Minute,
			},
		},
	}

	servers := cfg.MintICEServers("us-east", "user42", knownTime)
	if len(servers) != 1 {
		t.Fatalf("got %d ice servers, want 1", len(servers))
	}

	wantUsername := fmt.Sprintf("%d:%s", knownTime.Add(5*time.Minute).Unix(), "user42")
	if got := servers[0].GetUsername(); got != wantUsername {
		t.Errorf("username: got %q, want %q", got, wantUsername)
	}

	// Independent HMAC computation — proves the production code agrees
	// with the spec, not just with itself.
	mac := hmac.New(sha1.New, []byte("super-secret-shared-key"))
	mac.Write([]byte(wantUsername))
	wantCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got := servers[0].GetCredential(); got != wantCred {
		t.Errorf("credential: got %q, want %q", got, wantCred)
	}

	if got := servers[0].GetUrl(); got != "turn:turn.us-east.example.com:3478?transport=udp" {
		t.Errorf("url: got %q, want endpoint as-configured", got)
	}
}

// TestMintICEServers_KnownGoodVector pins MintICEServers' output against a
// once-by-hand-computed expected base64 string. If the underlying HMAC math
// or username encoding changes, this is the test that fails — and it WILL
// have failed in CI, not in production at 3am.
//
// The expected credential below was derived OUTSIDE this binary via
// openssl, so a bug in Go's crypto/hmac or crypto/sha1 would still surface
// here (an in-binary recomputation with the same stdlib would mask it):
//
//	printf '1780833900:user-vector' \
//	    | openssl dgst -sha1 -hmac 'vector-secret' -binary \
//	    | base64
//	# → SzUpNSkYjkju6cR4ln9fixvW9z4=
//
// Where 1780833900 = unix(knownTime + 5m), computed externally as
//
//	date -u -j -f '%Y-%m-%dT%H:%M:%SZ' '2026-06-07T12:05:00Z' +%s
//
// (BSD date) or `date -u -d '2026-06-07T12:05:00Z' +%s` on GNU.
//
// Use `printf` (no trailing newline) rather than `echo`/`<<<` to avoid
// silently HMACing a newline byte.
func TestMintICEServers_KnownGoodVector(t *testing.T) {
	t.Parallel()
	const (
		secret = "vector-secret"
		userID = "user-vector"

		// Hard-coded expected outputs — DO NOT replace with a stdlib
		// recomputation; circularity is precisely what this test guards
		// against. Re-derive externally per the file header if either
		// constant ever needs to change.
		wantUsername = "1780833900:user-vector"
		wantCred     = "SzUpNSkYjkju6cR4ln9fixvW9z4="
	)
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{
				Region:        "us-east",
				Endpoints:     []string{"turn:example:3478"},
				HMACSecret:    secret,
				CredentialTTL: 5 * time.Minute,
			},
		},
	}

	servers := cfg.MintICEServers("us-east", userID, knownTime)
	if len(servers) != 1 {
		t.Fatalf("got %d ice servers, want 1", len(servers))
	}
	if got := servers[0].GetUsername(); got != wantUsername {
		t.Errorf("username: got %q, want %q", got, wantUsername)
	}
	if got := servers[0].GetCredential(); got != wantCred {
		t.Errorf("credential: got %q, want %q", got, wantCred)
	}

	// Sanity: vector is a non-empty 28-char base64 (SHA1 = 20 bytes →
	// base64 = 28 chars including '='). Guards against an empty-output
	// regression that "got == want" alone wouldn't catch if both sides
	// drifted in tandem.
	if len(wantCred) != 28 {
		t.Fatalf("test vector self-check: credential length %d, want 28", len(wantCred))
	}
}

// TestMintICEServers_UnknownRegionReturnsEmpty: the caller (control's voice
// token mint path) should emit `ice_servers: []` when the channel's home
// region has no coturn config — fallback path is host + srflx ICE.
func TestMintICEServers_UnknownRegionReturnsEmpty(t *testing.T) {
	t.Parallel()
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{Region: "us-east", Endpoints: []string{"turn:a:3478"}, HMACSecret: "s"},
		},
	}
	if got := cfg.MintICEServers("eu-west", "user", knownTime); got != nil {
		t.Errorf("unknown region: got %d servers, want nil/0", len(got))
	}
	if got := cfg.MintICEServers("", "user", knownTime); got != nil {
		t.Errorf("empty region: got %d servers, want nil/0", len(got))
	}

	// Nil config = no TURN at all → empty. Guards against a nil-deref
	// regression if the config-load path returns nil for "no flag".
	var nilCfg *CoturnConfig
	if got := nilCfg.MintICEServers("us-east", "user", knownTime); got != nil {
		t.Errorf("nil config: got %d servers, want nil/0", len(got))
	}
}

// TestMintICEServers_RegionLookupIsCaseInsensitive: the config file is the
// source of truth for region casing, but the call site might pass anything
// (channel.HomeRegion uppercase, env var lowercase, etc.). EqualFold matches
// either way.
func TestMintICEServers_RegionLookupIsCaseInsensitive(t *testing.T) {
	t.Parallel()
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{Region: "us-east", Endpoints: []string{"turn:a:3478"}, HMACSecret: "s"},
		},
	}
	if got := cfg.MintICEServers("US-East", "user", knownTime); len(got) != 1 {
		t.Errorf("US-East: got %d, want 1 (case-insensitive lookup)", len(got))
	}
	if got := cfg.MintICEServers("US-EAST", "user", knownTime); len(got) != 1 {
		t.Errorf("US-EAST: got %d, want 1 (case-insensitive lookup)", len(got))
	}
}

// TestMintICEServers_TTLEncodedInUsername: the username's first segment IS
// the expiry timestamp. This is the property coturn's authenticator uses
// to reject a stolen credential after it lapses — without it, the leak
// window is unbounded.
func TestMintICEServers_TTLEncodedInUsername(t *testing.T) {
	t.Parallel()
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{
				Region:        "us-east",
				Endpoints:     []string{"turn:a:3478"},
				HMACSecret:    "s",
				CredentialTTL: 10 * time.Minute,
			},
		},
	}
	servers := cfg.MintICEServers("us-east", "user42", knownTime)
	username := servers[0].GetUsername()
	idx := strings.IndexByte(username, ':')
	if idx <= 0 {
		t.Fatalf("username %q missing ':' separator", username)
	}
	expiryUnix, err := strconv.ParseInt(username[:idx], 10, 64)
	if err != nil {
		t.Fatalf("username expiry segment not int: %q (%v)", username[:idx], err)
	}
	wantExpiry := knownTime.Add(10 * time.Minute).Unix()
	if expiryUnix != wantExpiry {
		t.Errorf("expiry encoded in username: got %d, want %d (knownTime + 10m)", expiryUnix, wantExpiry)
	}
	if got := username[idx+1:]; got != "user42" {
		t.Errorf("user id segment: got %q, want %q", got, "user42")
	}
}

// TestMintICEServers_ZeroTTLUsesDefault: leaving CredentialTTL at its
// zero-value should fall back to defaultCredentialTTL (5 min), not produce
// an immediately-expired credential.
func TestMintICEServers_ZeroTTLUsesDefault(t *testing.T) {
	t.Parallel()
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{Region: "us-east", Endpoints: []string{"turn:a:3478"}, HMACSecret: "s"},
		},
	}
	servers := cfg.MintICEServers("us-east", "user", knownTime)
	username := servers[0].GetUsername()
	idx := strings.IndexByte(username, ':')
	expiryUnix, _ := strconv.ParseInt(username[:idx], 10, 64)
	wantExpiry := knownTime.Add(defaultCredentialTTL).Unix()
	if expiryUnix != wantExpiry {
		t.Errorf("zero TTL → default: got expiry %d, want %d (knownTime + %v)",
			expiryUnix, wantExpiry, defaultCredentialTTL)
	}
}

// TestMintICEServers_EndpointFanout: a region with multiple endpoints gets
// one IceServer per endpoint, all sharing the same username + credential.
func TestMintICEServers_EndpointFanout(t *testing.T) {
	t.Parallel()
	cfg := &CoturnConfig{
		Regions: []CoturnRegion{
			{
				Region: "us-east",
				Endpoints: []string{
					"turn:turn.us-east.example.com:3478?transport=udp",
					"turn:turn.us-east.example.com:3478?transport=tcp",
					"turns:turn.us-east.example.com:5349?transport=tcp",
				},
				HMACSecret: "s",
			},
		},
	}
	servers := cfg.MintICEServers("us-east", "user", knownTime)
	if len(servers) != 3 {
		t.Fatalf("got %d ice servers, want 3", len(servers))
	}
	for i := 1; i < len(servers); i++ {
		if servers[i].GetUsername() != servers[0].GetUsername() {
			t.Errorf("endpoint %d username drifted from endpoint 0", i)
		}
		if servers[i].GetCredential() != servers[0].GetCredential() {
			t.Errorf("endpoint %d credential drifted from endpoint 0", i)
		}
	}
	if servers[0].GetUrl() == servers[1].GetUrl() {
		t.Errorf("endpoint URLs collapsed; want each preserved in order")
	}
}

// TestLoadConfigFile_RoundTrip writes a valid config, loads it, and asserts
// the resulting MintICEServers output matches what the inline-built config
// produces. Catches JSON tag drift between the struct and the on-disk shape.
func TestLoadConfigFile_RoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "coturn.json")
	body := `{
        "regions": [
            {
                "region": "us-east",
                "endpoints": ["turn:turn.us-east.example.com:3478"],
                "hmac_secret": "shared-secret",
                "credential_ttl": 300000000000
            }
        ]
    }`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	loaded, err := LoadConfigFile(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Regions) != 1 {
		t.Fatalf("got %d regions, want 1", len(loaded.Regions))
	}
	if loaded.Regions[0].CredentialTTL != 5*time.Minute {
		t.Errorf("credential_ttl: got %v, want 5m", loaded.Regions[0].CredentialTTL)
	}
	servers := loaded.MintICEServers("us-east", "user", knownTime)
	if len(servers) != 1 {
		t.Errorf("round-tripped config minted %d servers, want 1", len(servers))
	}
}

// TestLoadConfigFile_RejectsMalformed locks in the boot-time validation —
// missing region / endpoints / secret should crash the boot, not silently
// drop TURN.
func TestLoadConfigFile_RejectsMalformed(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"empty region":  `{"regions":[{"region":"","endpoints":["turn:a:3478"],"hmac_secret":"s"}]}`,
		"no endpoints":  `{"regions":[{"region":"us-east","endpoints":[],"hmac_secret":"s"}]}`,
		"empty secret":  `{"regions":[{"region":"us-east","endpoints":["turn:a:3478"],"hmac_secret":""}]}`,
		"invalid json":  `{ this is not json `,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "coturn.json")
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatalf("write config: %v", err)
			}
			if _, err := LoadConfigFile(path); err == nil {
				t.Errorf("LoadConfigFile(%q): want error, got nil", name)
			}
		})
	}
}

// TestLoadConfigFile_EmptyPathReturnsEmptyConfig: --coturn-config not set
// must produce an empty (but non-nil) CoturnConfig so MintICEServers returns
// nil cleanly.
func TestLoadConfigFile_EmptyPathReturnsEmptyConfig(t *testing.T) {
	t.Parallel()
	cfg, err := LoadConfigFile("")
	if err != nil {
		t.Fatalf("LoadConfigFile(\"\"): %v", err)
	}
	if cfg == nil {
		t.Fatal("LoadConfigFile(\"\") returned nil cfg; want empty cfg")
	}
	if len(cfg.Regions) != 0 {
		t.Errorf("LoadConfigFile(\"\") returned %d regions; want 0", len(cfg.Regions))
	}
	if got := cfg.MintICEServers("us-east", "user", knownTime); got != nil {
		t.Errorf("empty cfg → MintICEServers: got %d, want nil", len(got))
	}
}
