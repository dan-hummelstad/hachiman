// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"bytes"
	"testing"
)

func TestDecodeB64url(t *testing.T) {
	if b, err := decodeB64url("AQID"); err != nil || !bytes.Equal(b, []byte{1, 2, 3}) {
		t.Fatalf("AQID = %x, %v", b, err)
	}
	if b, err := decodeB64url("-_8"); err != nil || !bytes.Equal(b, []byte{0xfb, 0xff}) {
		t.Fatalf("-_8 = %x, %v", b, err)
	}
	for _, bad := range []string{"", "AQ==", "AQ=", "+/8", "AQ\nID", "AQ\rID", "AR" /* non-zero trailing bits */, "A"} {
		if _, err := decodeB64url(bad); err == nil {
			t.Errorf("%q decoded, want an error", bad)
		}
	}
}

func TestParseCommitHeader(t *testing.T) {
	gid := newVoiceGroupID()
	if len(gid) != groupIDLen || gid[0] != 1 || gid[1] != groupKindVoice || !bytes.Equal(gid[18:], []byte{0, 0, 0, 0}) {
		t.Fatalf("group id %x", gid)
	}
	if bytes.Equal(gid, newVoiceGroupID()) {
		t.Fatal("two room session ids are equal")
	}
	raw, _ := decodeB64url(fakeCommit(gid, 7, 3))
	h, err := parseCommitHeader(raw)
	if err != nil || !bytes.Equal(h.groupID, gid) || h.epoch != 7 || h.leafIndex != 3 {
		t.Fatalf("header %+v, %v", h, err)
	}

	// A 64-byte group id needs the 2-byte prefix; the 1-byte form cannot hold it.
	long := bytes.Repeat([]byte{9}, 64)
	b := append([]byte{0, 1, 0, 1, 0x40, 64}, long...)
	b = append(b, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 2)
	if h, err := parseCommitHeader(b); err != nil || len(h.groupID) != 64 || h.epoch != 1 || h.leafIndex != 2 {
		t.Fatalf("2-byte prefix: %+v, %v", h, err)
	}

	mutate := func(i int, v byte) []byte {
		c := append([]byte(nil), raw...)
		c[i] = v
		return c
	}
	for name, bad := range map[string][]byte{
		"empty":             nil,
		"version 2":         mutate(1, 2),
		"private message":   mutate(3, 2),
		"sender external":   mutate(4+1+groupIDLen+8, 2),
		"reserved prefix":   mutate(4, 0xc0),
		"non-minimal":       append([]byte{0, 1, 0, 1, 0x40, groupIDLen}, raw[5:]...),
		"non-minimal 4":     append([]byte{0, 1, 0, 1, 0x80, 0, 0, groupIDLen}, raw[5:]...),
		"short group id":    raw[:4+1+10],
		"short after group": raw[:4+1+groupIDLen+8+1+2],
	} {
		if _, err := parseCommitHeader(bad); err == nil {
			t.Errorf("%s: parsed, want an error", name)
		}
	}
}
