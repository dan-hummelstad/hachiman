// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// oracleIntrospectTimeout bounds the round-trip to the Oracle introspection
// endpoint. It's enforced via http.Client.Timeout (covers connect + body
// read), so even if the AS hangs after sending headers we won't block the
// per-client authentication goroutine indefinitely.
const oracleIntrospectTimeout = 5 * time.Second

// oracleHTTPClient is shared across introspection calls so the underlying
// transport pool is reused. The Timeout applies per-request.
var oracleHTTPClient = &http.Client{Timeout: oracleIntrospectTimeout}

// OracleIntrospectionResult is the subset of an RFC 7662 introspection
// response we care about. Unknown fields in the JSON are ignored.
type OracleIntrospectionResult struct {
	Active            bool   `json:"active"`
	Sub               string `json:"sub"`
	PreferredUsername string `json:"preferred_username"`
	Email             string `json:"email"`
	ClientID          string `json:"client_id"`
	Exp               int64  `json:"exp"`
	Scope             string `json:"scope"`
}

// OracleIntrospectConfig captures what the server needs to perform RFC 7662
// introspection against the configured Oracle/Takusen endpoint. All three
// fields are required for introspection to be attempted.
type OracleIntrospectConfig struct {
	URL          string
	ClientID     string
	ClientSecret string
}

// Enabled reports whether the config is sufficiently populated to attempt
// introspection. We deliberately require the client_id as well as the URL +
// secret so we can defensively verify the audience binding on the response.
func (c OracleIntrospectConfig) Enabled() bool {
	return c.URL != "" && c.ClientID != "" && c.ClientSecret != ""
}

// introspectOracleToken POSTs the token to the configured introspection
// endpoint and returns the parsed result on success. Errors are returned for
// network/HTTP failures, malformed responses, or audience mismatch. A nil
// error with `active: false` is *not* treated as an error here — the caller
// decides how to react (anonymous fallback vs. AuthenticatorFail) based on
// whether OracleOnly is set.
func introspectOracleToken(cfg OracleIntrospectConfig, token string) (*OracleIntrospectionResult, error) {
	if !cfg.Enabled() {
		return nil, errors.New("oracle introspection not configured")
	}
	if token == "" {
		return nil, errors.New("empty oracle token")
	}

	form := url.Values{}
	form.Set("token", token)
	form.Set("token_type_hint", "access_token")

	ctx, cancel := context.WithTimeout(context.Background(), oracleIntrospectTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build introspection request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// RFC 7662 §2.1: client_secret_basic.
	req.SetBasicAuth(cfg.ClientID, cfg.ClientSecret)

	resp, err := oracleHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oracle introspection HTTP error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Drain a small amount of the body to give a useful error message.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("oracle introspection returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result OracleIntrospectionResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode introspection response: %w", err)
	}

	// Defense in depth: a properly configured panva AS will only return
	// active=true for tokens issued to OUR client_id, but we double-check
	// here so a mis-shared introspection endpoint can't expose us to
	// cross-server token replay.
	if result.Active && result.ClientID != "" && result.ClientID != cfg.ClientID {
		return nil, fmt.Errorf(
			"oracle introspection audience mismatch: token client_id=%q, expected %q",
			result.ClientID, cfg.ClientID)
	}

	return &result, nil
}
