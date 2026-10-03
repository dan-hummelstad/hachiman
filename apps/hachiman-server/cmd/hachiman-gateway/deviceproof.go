// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// IDENTIFY and RESUME device proof (§12.13): the device signs with its MLS
// signature key (devices.mls_signature_key). A bearer token alone thus cannot
// claim a device. The message is deviceProofMessage of @hachiman/crypto
// (pkgs/hachiman-crypto/src/device-proof.ts), kind "identify".
const (
	deviceProofVersion = "hachiman-device-proof/1"
	deviceProofMaxSkew = 5 * time.Minute
	// Twice the skew window: a nonce stays remembered while its ts can pass.
	deviceProofNonceTTL = 2 * deviceProofMaxSkew
)

var deviceProofNonceRe = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func kDeviceNonce(deviceID, nonce string) string {
	return "device_nonce:" + deviceID + ":" + nonce
}

type deviceProof struct {
	Ts    int64
	Nonce string
	Sig   string
}

// identifyProofMessage is the signed message of IDENTIFY (sessionID "") and
// RESUME.
func identifyProofMessage(deviceID, sessionID string, ts int64, nonce, token string) []byte {
	h := sha256.Sum256([]byte(token))
	return []byte(strings.Join([]string{
		deviceProofVersion, "identify", deviceID, sessionID,
		strconv.FormatInt(ts, 10), nonce, base64.RawURLEncoding.EncodeToString(h[:]),
	}, "\n"))
}

// checkDeviceProof runs after check 3: the proof verifies under the device
// key, ts is within 5 minutes and the nonce is new. Else close 4004. The nonce
// is claimed only after the signature verifies.
func (g *Gateway) checkDeviceProof(ctx context.Context, d deviceRow, deviceID, sessionID, token string, p *deviceProof) error {
	if p == nil || len(d.SignatureKey) != ed25519.PublicKeySize || !deviceProofNonceRe.MatchString(p.Nonce) {
		return errAuthFailed
	}
	if skew := time.Since(time.UnixMilli(p.Ts)); skew > deviceProofMaxSkew || skew < -deviceProofMaxSkew {
		return errAuthFailed
	}
	sig, err := base64.RawURLEncoding.DecodeString(p.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errAuthFailed
	}
	if !ed25519.Verify(ed25519.PublicKey(d.SignatureKey), identifyProofMessage(deviceID, sessionID, p.Ts, p.Nonce, token), sig) {
		return errAuthFailed
	}
	fresh, err := g.rdb.SetNX(ctx, kDeviceNonce(deviceID, p.Nonce), 1, deviceProofNonceTTL).Result()
	if err != nil {
		return fmt.Errorf("device nonce: %w", err)
	}
	if !fresh {
		return errAuthFailed
	}
	return nil
}
