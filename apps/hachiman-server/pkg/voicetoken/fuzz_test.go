// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken_test

import (
	"path/filepath"
	"strings"
	"testing"

	"hachiman/server/pkg/voicetoken"
)

// FuzzVerify: Verify never panics on an arbitrary token string, and a token
// that verifies carries exactly the minted claims (the signature covers
// every claim). A fresh Verifier per input keeps the replay cache out of it.
//
//	go test ./pkg/voicetoken -run '^$' -fuzz '^FuzzVerify$' -fuzztime 30s
func FuzzVerify(f *testing.F) {
	s, err := voicetoken.NewSigner(filepath.Join(f.TempDir(), "voice-signer.ed25519"))
	if err != nil {
		f.Fatal(err)
	}
	want := validClaims()
	tok, err := s.Mint(want)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(tok)
	f.Add(strings.TrimPrefix(tok, "v4.public."))
	f.Add("v4.local." + strings.TrimPrefix(tok, "v4.public."))
	f.Add("v4.public.")
	f.Add("")
	f.Fuzz(func(t *testing.T, in string) {
		v, err := voicetoken.NewVerifier(s.PublicKeyHex(), testNodeID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := v.Verify(in)
		if err != nil {
			return
		}
		if got.SessionID != want.SessionID || got.UserID != want.UserID || got.DeviceID != want.DeviceID || got.GuildID != want.GuildID ||
			got.ChannelID != want.ChannelID || got.MediaNodeID != want.MediaNodeID || got.JTI != want.JTI ||
			!got.IssuedAt.Equal(want.IssuedAt) || !got.ExpiresAt.Equal(want.ExpiresAt) {
			t.Fatalf("%q verified with other claims: %+v", in, got)
		}
	})
}
