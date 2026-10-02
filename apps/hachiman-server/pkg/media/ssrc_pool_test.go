// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package media

import "testing"

func TestSSRCPool_UniqueNonZeroAndIdempotent(t *testing.T) {
	p := NewSSRCPool()
	a, b := p.Get("a"), p.Get("b")
	if a == 0 || b == 0 || a == b {
		t.Fatalf("Get: a=%d b=%d, want distinct non-zero", a, b)
	}
	if p.Get("a") != a {
		t.Error("Get not idempotent")
	}
}

func TestSSRCPool_ReleaseIdempotentAndNoReuseWhileHeld(t *testing.T) {
	p := NewSSRCPool()
	a := p.Get("a")
	p.Release("a")
	p.Release("a")
	if p.Len() != 0 {
		t.Fatalf("Len after release = %d", p.Len())
	}
	// Force wrap: the counter must skip values still held by live sessions.
	b := p.Get("b")
	p.next = b - 1
	if c := p.Get("c"); c == b {
		t.Errorf("Get reused held ssrc %d", b)
	}
	_ = a
}

func TestSSRCPool_SkipsZeroOnWrap(t *testing.T) {
	p := NewSSRCPool()
	p.next = ^uint32(0)
	if got := p.Get("x"); got == 0 {
		t.Error("allocated reserved ssrc 0")
	}
}
