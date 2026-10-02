// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

// Package coturn mints time-bounded TURN credentials per the coturn REST API
// scheme — `username = <expiry-unix>:<user-id>`, `credential = base64(HMAC-SHA1(
// secret, username))`. ICEServer marshals straight into the browser
// RTCIceServer shape the gateway sends in VOICE_SERVER_UPDATE.iceServers.
//
// TURN is per-region, co-located with the media nodes: each region has its own
// coturn cluster, HMAC secret and endpoint list. CoturnConfig looks the region
// up; CoturnRegion.Mint builds one ICEServer per endpoint.
package coturn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// ICEServer is the JSON shape of a browser RTCIceServer.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// defaultCredentialTTL is the per-region credential TTL when CoturnRegion
// leaves CredentialTTL zero. 5 minutes matches the recommended window in
// coturn's "Using TURN REST API" docs — short enough to bound replay if
// the credential leaks, long enough to outlast typical ICE gathering +
// allocate cycles.
const defaultCredentialTTL = 5 * time.Minute

// CoturnRegion describes a single region's coturn cluster. The HMAC secret
// MUST match the `static-auth-secret` (or `secret-key`) configured on every
// turnserver instance in the region. Endpoints are full coturn URLs as they
// appear on the wire to the client, e.g.
// `turn:turn.us-east.example.com:3478?transport=udp`.
type CoturnRegion struct {
	// Region machine code, e.g. "us-east". Case-insensitive on lookup; the
	// canonical form is whatever was loaded from config.
	Region string `json:"region"`

	// Endpoints is the ordered list of TURN URLs published to the client in
	// VOICE_SERVER_UPDATE.iceServers. Order is significant — the client tries
	// them in order during ICE gathering. Typical shape is one UDP and one
	// TCP fallback per region.
	Endpoints []string `json:"endpoints"`

	// HMACSecret is the shared secret with the regional coturn cluster.
	// Rotated independently per region per Phase 3 step 6.
	HMACSecret string `json:"hmac_secret"`

	// CredentialTTL is the TTL the minted username encodes. Zero (the
	// JSON-omitted default) uses defaultCredentialTTL.
	CredentialTTL time.Duration `json:"credential_ttl"`
}

// CoturnConfig is the top-level config envelope loaded from disk via
// --coturn-config. An empty Regions slice (or no file at all) leaves
// MintICEServers returning the empty slice — the caller emits
// `iceServers: []` and the client falls back to host + srflx candidates
// only. Useful for dev where no TURN is provisioned.
type CoturnConfig struct {
	Regions []CoturnRegion `json:"regions"`
}

// LoadConfigFile reads a JSON-encoded CoturnConfig from path. The file is
// validated for non-empty Region + at least one Endpoint + non-empty
// HMACSecret per entry; partial / malformed regions return an error so a
// typo at deploy time surfaces at boot rather than silently dropping TURN.
func LoadConfigFile(path string) (*CoturnConfig, error) {
	if path == "" {
		return &CoturnConfig{}, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("coturn: read %q: %w", path, err)
	}
	var cfg CoturnConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("coturn: parse %q: %w", path, err)
	}
	for i, r := range cfg.Regions {
		if strings.TrimSpace(r.Region) == "" {
			return nil, fmt.Errorf("coturn: region[%d]: empty region", i)
		}
		if len(r.Endpoints) == 0 {
			return nil, fmt.Errorf("coturn: region[%d] (%q): no endpoints", i, r.Region)
		}
		if r.HMACSecret == "" {
			return nil, fmt.Errorf("coturn: region[%d] (%q): empty hmac_secret", i, r.Region)
		}
	}
	return &cfg, nil
}

// MintICEServers builds the per-session IceServer slice for the given region
// + user id at wall-clock time `now`. The username is `<expiry>:<userID>`
// per the coturn REST API scheme; the credential is
// `base64(HMAC-SHA1(secret, username))`. Unknown regions return an empty
// slice — the caller emits `iceServers: []` and the client falls back to
// host / srflx candidates.
//
// Region lookup is case-insensitive (so "us-east" config matches "US-East"
// at the call site); the response carries the matched region's username +
// credential unchanged.
func (c *CoturnConfig) MintICEServers(region string, userID string, now time.Time) []ICEServer {
	if c == nil || region == "" {
		return nil
	}
	var match *CoturnRegion
	for i := range c.Regions {
		if strings.EqualFold(c.Regions[i].Region, region) {
			match = &c.Regions[i]
			break
		}
	}
	if match == nil {
		return nil
	}
	return match.Mint(userID, now)
}

// Mint builds one ICEServer per endpoint, all sharing a credential that
// expires CredentialTTL after now.
func (r CoturnRegion) Mint(userID string, now time.Time) []ICEServer {
	ttl := r.CredentialTTL
	if ttl <= 0 {
		ttl = defaultCredentialTTL
	}
	username := fmt.Sprintf("%d:%s", now.Add(ttl).Unix(), userID)
	credential := signHMACSHA1Base64(r.HMACSecret, username)
	out := make([]ICEServer, 0, len(r.Endpoints))
	for _, ep := range r.Endpoints {
		out = append(out, ICEServer{URLs: []string{ep}, Username: username, Credential: credential})
	}
	return out
}

// signHMACSHA1Base64 is the coturn REST API credential signature: HMAC-SHA1
// of `username` keyed with `secret`, base64-encoded (standard alphabet, no
// padding stripped). Exposed at package-internal scope so the test can
// independently compute the expected bytes.
func signHMACSHA1Base64(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
