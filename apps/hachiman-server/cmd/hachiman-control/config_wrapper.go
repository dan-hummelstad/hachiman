package main

import (
	"strconv"
	"sync"

	"mumble.info/grumble/pkg/database"
	"mumble.info/grumble/pkg/serverconf"
)

// ConfigWrapper bridges the in-memory serverconf.ConfigRepo interface that
// the rest of Grumble talks to against the per-vServer `config` table.
//
// PERF: a naive implementation opens a new database transaction on every
// StringValue / IntValue / BoolValue call. handleAuthenticate alone reads
// six different config keys per inbound auth, so a busy server would spam
// SELECT statements at line rate. We layer an in-memory cache on top of the
// DB read with the following invariants:
//
//   - Single-process cache only. Each Server owns one ConfigWrapper, so the
//     cache lifetime matches the in-process Server.
//   - Cached on first read. The cached value is the *resolved* string —
//     either the DB value (when set) or the serverconf.DefaultCfg fallback
//     — so callers see the same semantics as the un-cached path.
//   - Invalidated on Set. Writes via THIS wrapper update both the DB and
//     the cache atomically. Direct writes via `tx.ConfigSet` (e.g. the
//     management gRPC service stamping AdminOracleUserID at vServer
//     creation, BEFORE the Server is constructed) are not visible to the
//     cache — that's OK in practice because they happen before any cache
//     read could have populated, but any FUTURE direct-write path that
//     overlaps with a running Server must call ConfigInvalidate (added
//     below) to avoid stale reads.
type ConfigWrapper struct {
	db       *database.GrumbleDb
	serverID uint64

	mu    sync.RWMutex
	cache map[string]string
}

func NewConfigWrapper(db *database.GrumbleDb, serverID uint64) serverconf.ConfigRepo {
	return &ConfigWrapper{
		db:       db,
		serverID: serverID,
		cache:    make(map[string]string),
	}
}

func (c *ConfigWrapper) Set(key, value string) {
	tx := c.db.Tx()
	defer tx.Commit()

	tx.ConfigSet(c.serverID, key, value)

	c.mu.Lock()
	c.cache[key] = value
	c.mu.Unlock()
}

func (c *ConfigWrapper) StringValue(key string) string {
	// Fast path: cached resolved value (either from DB or DefaultCfg).
	c.mu.RLock()
	if v, ok := c.cache[key]; ok {
		c.mu.RUnlock()
		return v
	}
	c.mu.RUnlock()

	// Slow path: hit the DB once, then cache the resolved value.
	tx := c.db.Tx()
	defer tx.Rollback()

	val, err := tx.ConfigGet(c.serverID, key)
	if err != nil {
		// Don't cache transient DB errors — let the next call retry.
		return ""
	}

	if val == "" {
		if def, ok := serverconf.DefaultCfg[key]; ok {
			val = def
		}
	}

	c.mu.Lock()
	c.cache[key] = val
	c.mu.Unlock()

	return val
}

// ConfigInvalidate drops the cached value for `key` so the next read
// re-queries the database. Use this from any code path that writes the
// underlying config row outside of this wrapper (e.g. an out-of-band
// management RPC that mutates a per-vServer config while the Server is
// running). No-op if `key` was never cached.
//
// Not part of the serverconf.ConfigRepo interface (kept narrow); callers
// must type-assert to *ConfigWrapper to use this.
func (c *ConfigWrapper) ConfigInvalidate(key string) {
	c.mu.Lock()
	delete(c.cache, key)
	c.mu.Unlock()
}

// IntValue gets the value of a speific config key as an int
func (cfg *ConfigWrapper) IntValue(key string) (intval int) {
	str := cfg.StringValue(key)
	intval, _ = strconv.Atoi(str)
	return
}

// Uint32Value gets the value of a specific config key as a uint32
func (cfg *ConfigWrapper) Uint32Value(key string) (uint32val uint32) {
	str := cfg.StringValue(key)
	uintval, _ := strconv.ParseUint(str, 10, 0)
	return uint32(uintval)
}

// BoolValue gets the value fo a sepcific config key as a bool
func (cfg *ConfigWrapper) BoolValue(key string) (boolval bool) {
	str := cfg.StringValue(key)
	boolval, _ = strconv.ParseBool(str)
	return
}
