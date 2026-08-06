// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package voicetoken

import (
	"container/list"
	"sync"
	"time"
)

// ReplayCache is a bounded LRU of seen JTIs with per-entry expiry.
//
// Used by media to reject duplicate tokens (a token replayed within its TTL
// window). Per the rev-6 architectural call, this is per-node in-memory
// state: media is stateless and autoscaled, so LRU loss on node replacement
// is accepted. The DTLS-fingerprint binding + token TTL bound the residual
// risk to a few seconds against a specific peer.
//
// Capacity defaults to 10_000 entries — enough for ~1k sessions/s under the
// 2-minute max TTL with comfortable headroom.
type ReplayCache struct {
	mu       sync.Mutex
	capacity int
	// order holds *replayEntry, MRU at front.
	order *list.List
	// index maps jti → *list.Element pointing at the entry in `order`.
	index map[string]*list.Element
}

type replayEntry struct {
	jti       string
	expiresAt time.Time
}

// NewReplayCache constructs a cache with the given capacity. A capacity of
// zero or negative is treated as "no replay protection" (every Seen returns
// false) — useful for tests that want to bypass the check.
func NewReplayCache(capacity int) *ReplayCache {
	if capacity < 0 {
		capacity = 0
	}
	return &ReplayCache{
		capacity: capacity,
		order:    list.New(),
		index:    make(map[string]*list.Element),
	}
}

// SeenOrAdd checks whether jti has been observed. If yes, returns true
// (caller should reject the token). If no, records it with the given expiry
// and returns false.
//
// Concurrent-safe.
func (c *ReplayCache) SeenOrAdd(jti string, expiresAt time.Time) bool {
	if c.capacity == 0 {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	c.evictExpiredLocked()

	if _, ok := c.index[jti]; ok {
		// Duplicate — report it but DO NOT promote to MRU. The cache is for
		// replay detection, not access frequency; promoting would let an
		// attacker keep a known-good jti alive past its natural TTL by
		// re-presenting it, blocking eviction of older legitimate entries.
		return true
	}

	entry := &replayEntry{jti: jti, expiresAt: expiresAt}
	el := c.order.PushFront(entry)
	c.index[jti] = el

	for c.order.Len() > c.capacity {
		old := c.order.Back()
		if old == nil {
			break
		}
		c.order.Remove(old)
		delete(c.index, old.Value.(*replayEntry).jti)
	}
	return false
}

// Len returns the current entry count. Test/observability helper.
func (c *ReplayCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

func (c *ReplayCache) evictExpiredLocked() {
	now := time.Now()
	for {
		old := c.order.Back()
		if old == nil {
			return
		}
		entry := old.Value.(*replayEntry)
		if entry.expiresAt.After(now) {
			return
		}
		c.order.Remove(old)
		delete(c.index, entry.jti)
	}
}
