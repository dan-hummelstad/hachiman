// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package media

import "sync"

// SSRCPool hands out node-unique, non-zero SSRCs keyed by session id. Media is
// the only allocator (per node), so no cross-process agreement is needed.
type SSRCPool struct {
	mu       sync.Mutex
	next     uint32
	assigned map[string]uint32 // session -> ssrc
	inUse    map[uint32]struct{}
}

func NewSSRCPool() *SSRCPool {
	return &SSRCPool{assigned: map[string]uint32{}, inUse: map[uint32]struct{}{}}
}

// Get returns session's SSRC, allocating one on first use. Idempotent.
func (p *SSRCPool) Get(session string) uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ssrc, ok := p.assigned[session]; ok {
		return ssrc
	}
	// Linear probe past in-use values; 0 is reserved as "none". The pool can
	// never be full in practice (2^32 ids vs max_sessions per node).
	for {
		p.next++
		if _, taken := p.inUse[p.next]; p.next != 0 && !taken {
			break
		}
	}
	p.assigned[session] = p.next
	p.inUse[p.next] = struct{}{}
	return p.next
}

// Release frees session's SSRC. Idempotent.
func (p *SSRCPool) Release(session string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ssrc, ok := p.assigned[session]; ok {
		delete(p.assigned, session)
		delete(p.inUse, ssrc)
	}
}

// Len is the number of sessions holding an SSRC.
func (p *SSRCPool) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.assigned)
}
