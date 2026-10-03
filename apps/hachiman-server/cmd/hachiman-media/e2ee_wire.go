// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strings"
)

// Wire helpers for the voice E2EE ops (§8, §12.2, §12.10.1). The media node
// has no MLS library: it reads only the fixed commit header below.

const (
	groupKindVoice = 4
	groupIDLen     = 22 // GroupId: version, kind, scope[16], uint32 generation
)

var errMalformed = errors.New("malformed")

// decodeB64url decodes §12.2 base64url: no padding, the URL alphabet only,
// zero trailing bits. Go's decoder skips CR/LF, so they are rejected here.
func decodeB64url(s string) ([]byte, error) {
	if s == "" || strings.ContainsAny(s, "\r\n") {
		return nil, errMalformed
	}
	return base64.RawURLEncoding.Strict().DecodeString(s)
}

func encodeB64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// newVoiceGroupID returns GroupId{version 1, kind voice, scope = 16 random
// bytes (the room session id), generation 0}.
func newVoiceGroupID() []byte {
	id := make([]byte, groupIDLen)
	id[0], id[1] = 1, groupKindVoice
	if _, err := rand.Read(id[2:18]); err != nil {
		panic("media: crypto/rand: " + err.Error()) // never returns an error on supported platforms
	}
	return id
}

// commitHeader is the start of an MLSMessage PublicMessage commit.
type commitHeader struct {
	groupID   []byte
	epoch     uint64
	leafIndex uint32
}

// parseCommitHeader reads `uint16 version (1) ‖ uint16 wire_format (1) ‖
// opaque group_id<V> ‖ uint64 epoch ‖ uint8 sender_type (1) ‖ uint32
// leaf_index`. It checks the constant fields and the minimal <V> prefix.
// The bytes after the header stay opaque.
func parseCommitHeader(b []byte) (commitHeader, error) {
	var h commitHeader
	if len(b) < 4 || binary.BigEndian.Uint16(b) != 1 || binary.BigEndian.Uint16(b[2:]) != 1 {
		return h, errMalformed
	}
	b = b[4:]
	n, rest, err := readVarint(b)
	if err != nil || uint64(len(rest)) < n {
		return h, errMalformed
	}
	h.groupID, b = rest[:n], rest[n:]
	if len(b) < 8+1+4 || b[8] != 1 {
		return h, errMalformed
	}
	h.epoch = binary.BigEndian.Uint64(b)
	h.leafIndex = binary.BigEndian.Uint32(b[9:])
	return h, nil
}

// readVarint reads the RFC 9420 §2.1.2 length prefix and rejects a
// non-minimal encoding and the reserved 0b11 prefix.
func readVarint(b []byte) (uint64, []byte, error) {
	if len(b) == 0 {
		return 0, nil, errMalformed
	}
	switch b[0] >> 6 {
	case 0:
		return uint64(b[0] & 0x3f), b[1:], nil
	case 1:
		if len(b) < 2 {
			return 0, nil, errMalformed
		}
		v := uint64(binary.BigEndian.Uint16(b) & 0x3fff)
		if v < 64 {
			return 0, nil, errMalformed
		}
		return v, b[2:], nil
	case 2:
		if len(b) < 4 {
			return 0, nil, errMalformed
		}
		v := uint64(binary.BigEndian.Uint32(b) & 0x3fffffff)
		if v < 16384 {
			return 0, nil, errMalformed
		}
		return v, b[4:], nil
	}
	return 0, nil, errMalformed
}
