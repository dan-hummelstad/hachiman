// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

// Package islandmetrics is the per-island live-metrics publisher.
//
// Each Grumble process (an "island" in the managed multi-tenant platform —
// see apps/oracle/ISLAND-PLATFORM.md) periodically publishes a tiny snapshot
// of its current load to Redis. The Oracle scheduler reads those snapshots
// at placement time to bin-pack new vServers onto the least-loaded island in
// a region. The snapshot is a single HASH per island at
// `island:{islandId}:metrics`, TTL'd so a stopped publisher's metrics expire
// (staleness via key absence is the cleanest signal).
//
// The publisher is OPT-IN. With either the Redis URL or the island id empty
// (the default), nothing in this package is touched: the self-host
// zero-config flow opens no Redis connection and starts no goroutine.
// `cmd/grumble` gates the launch — see main()'s metrics block.
//
// SCHEMA (mirrored on the consumer side in apps/oracle/src/lib/island-metrics.ts):
//
//	HASH  island:{islandId}:metrics
//	  activeUsers   int    — sum of len(server.clients) across the island
//	  cpuPct        float  — CPU utilisation in [0,1] (stubbed at 0 today)
//	  bandwidthPct  float  — bandwidth utilisation in [0,1] (stubbed at 0 today)
//	  publishedAt   int64  — unix milliseconds at write time
//	TTL = PublishInterval * StalenessMultiplier (default 5s * 3 = 15s)
//
// The publisher MUST NOT block the voice hot path: it runs on its own ticker
// and only iterates the in-process server registry's snapshot slice, never
// per-packet work. Failures on the wire are logged and swallowed — a missing
// publication just means the scheduler scores the island with
// MISSING_ISLAND_METRICS for one cycle, exactly as if the island had never
// published.
package islandmetrics

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// RegistrySnapshot is the narrow read-only view the publisher needs into the
// in-process vServer registry. cmd/grumble's *ServerRegistry already satisfies
// this via its List() method; defining the interface here keeps this package
// dependency-free of cmd/grumble (which is `package main` and cannot be
// imported anyway).
//
// The implementation must return a SNAPSHOT — the publisher iterates without
// holding any caller lock. cmd/grumble.ServerRegistry.List() does this by
// copying the map values out under its own RLock before returning.
type RegistrySnapshot interface {
	List() []ClientCounter
}

// ClientCounter is the per-vServer fact the publisher needs: how many users
// are currently connected. Kept as a narrow interface so cmd/grumble can adapt
// its *Server type without exposing the whole Server struct here.
type ClientCounter interface {
	// ClientCount returns the number of currently-connected clients on this
	// vServer. Implementations may read the underlying map without a lock if
	// the live code does so (existing Grumble code reads len(server.clients)
	// from the UDP handler without a lock too — a brief stale count is
	// acceptable for metrics).
	ClientCount() int
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Config bundles the publisher's settings. Built by cmd/grumble from the
// IslandMetricsRedisURL / IslandMetricsIslandID / IslandMetricsPublishIntervalSec
// CLI flags + env vars (see args.go).
//
// IMPORTANT: both RedisURL and IslandID must be non-empty for the publisher to
// be launched. cmd/grumble enforces this gate; New() validates again here as a
// second line of defence (so a programming bug can't sneak in a publisher with
// no destination or no identity).
type Config struct {
	// RedisURL is the redis:// connection string, e.g. "redis://localhost:6379".
	// Empty disables the publisher.
	RedisURL string

	// IslandID is the UUID this Grumble process publishes under. It must match
	// the Oracle `islands.id` row so the scheduler can correlate. Empty
	// disables the publisher.
	IslandID string

	// PublishInterval is how often metrics are pushed to Redis. Defaults to
	// DefaultPublishInterval if zero or negative.
	PublishInterval time.Duration

	// StalenessMultiplier sets the key TTL relative to PublishInterval. Default
	// is DefaultStalenessMultiplier (3). With 5s interval + 3x multiplier, the
	// key lingers for 15s after the last successful publish — a single missed
	// tick is forgiven, three in a row are not (the scheduler falls back to
	// MISSING_ISLAND_METRICS).
	StalenessMultiplier int
}

// Defaults — public so callers and docs can refer to them.
const (
	DefaultPublishInterval     = 5 * time.Second
	DefaultStalenessMultiplier = 3
)

// MetricsKey returns the Redis key for an island's metrics hash, in the
// canonical "island:{id}:metrics" format. Exported so tests and the consumer
// (Oracle) can stay in lock-step without duplicating the format string.
func MetricsKey(islandID string) string {
	return "island:" + islandID + ":metrics"
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

// Publisher periodically aggregates per-island metrics from the in-process
// server registry and writes them to Redis. It is safe to construct only via
// New(); the zero value is not usable.
type Publisher struct {
	cfg      Config
	registry RegistrySnapshot
	client   redis.UniversalClient
	logger   *log.Logger

	// ttl is precomputed from PublishInterval * StalenessMultiplier.
	ttl time.Duration
}

// New constructs a Publisher and dials Redis. Returns an error if the config
// is invalid (empty URL or empty island id) or the URL fails to parse — but
// does NOT fail on a Redis being unreachable yet. A live connection check
// happens on the first publish, where transient errors are logged and the
// publisher keeps going.
//
// Pass the returned Publisher to Run() in a goroutine; cancel its ctx to
// trigger a clean shutdown. Logger may be nil → defaults to log.Default().
func New(cfg Config, registry RegistrySnapshot, logger *log.Logger) (*Publisher, error) {
	if cfg.RedisURL == "" {
		return nil, errors.New("islandmetrics: RedisURL must be non-empty")
	}
	if cfg.IslandID == "" {
		return nil, errors.New("islandmetrics: IslandID must be non-empty")
	}
	if registry == nil {
		return nil, errors.New("islandmetrics: registry must be non-nil")
	}

	if cfg.PublishInterval <= 0 {
		cfg.PublishInterval = DefaultPublishInterval
	}
	if cfg.StalenessMultiplier <= 0 {
		cfg.StalenessMultiplier = DefaultStalenessMultiplier
	}

	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("islandmetrics: invalid RedisURL: %w", err)
	}

	if logger == nil {
		logger = log.Default()
	}

	return &Publisher{
		cfg:      cfg,
		registry: registry,
		client:   redis.NewClient(opts),
		logger:   logger,
		ttl:      cfg.PublishInterval * time.Duration(cfg.StalenessMultiplier),
	}, nil
}

// newWithClient is the test seam: it lets the unit tests inject a fake redis
// client backed by miniredis (or a mock) without going through ParseURL.
// Production code uses New().
func newWithClient(cfg Config, registry RegistrySnapshot, client redis.UniversalClient, logger *log.Logger) *Publisher {
	if cfg.PublishInterval <= 0 {
		cfg.PublishInterval = DefaultPublishInterval
	}
	if cfg.StalenessMultiplier <= 0 {
		cfg.StalenessMultiplier = DefaultStalenessMultiplier
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Publisher{
		cfg:      cfg,
		registry: registry,
		client:   client,
		logger:   logger,
		ttl:      cfg.PublishInterval * time.Duration(cfg.StalenessMultiplier),
	}
}

// Run blocks until ctx is cancelled, publishing one snapshot per
// PublishInterval. The Redis client is closed before Run returns.
//
// A publish failure (network error, Redis down, etc.) is LOGGED at info level
// and the loop continues — losing one publication is not fatal, the
// scheduler tolerates a missing key (it falls back to MISSING_ISLAND_METRICS).
func (p *Publisher) Run(ctx context.Context) {
	defer func() {
		if err := p.client.Close(); err != nil {
			p.logger.Printf("islandmetrics: redis close: %v", err)
		}
	}()

	p.logger.Printf("islandmetrics: publishing island=%s every %s (TTL=%s) → %s",
		p.cfg.IslandID, p.cfg.PublishInterval, p.ttl, p.cfg.RedisURL)

	// Publish once immediately so the scheduler sees us within the first
	// PublishInterval rather than after it. A startup-time failure is logged
	// like any other and we proceed to the ticker.
	if err := p.publishOnce(ctx); err != nil {
		p.logger.Printf("islandmetrics: initial publish failed (will retry on tick): %v", err)
	}

	t := time.NewTicker(p.cfg.PublishInterval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			p.logger.Printf("islandmetrics: shutting down (ctx done)")
			return
		case <-t.C:
			if err := p.publishOnce(ctx); err != nil {
				p.logger.Printf("islandmetrics: publish failed: %v", err)
			}
		}
	}
}

// publishOnce snapshots the registry, aggregates per-island metrics, and writes
// them to Redis in a single pipelined HSET + EXPIRE. Exported via test seams
// only.
func (p *Publisher) publishOnce(ctx context.Context) error {
	snap := aggregate(p.registry)
	snap.PublishedAt = time.Now().UnixMilli()

	key := MetricsKey(p.cfg.IslandID)
	fields := snap.fields()

	// Pipeline so HSET + EXPIRE go over the wire in one round trip. We don't
	// care about HSET's return (number of new fields); we DO care that EXPIRE
	// succeeded — a forgotten TTL would let a stopped publisher's stale data
	// linger forever, which is exactly the staleness scenario the TTL guards
	// against. Both are checked below.
	pipe := p.client.Pipeline()
	hset := pipe.HSet(ctx, key, fields)
	expire := pipe.Expire(ctx, key, p.ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	if err := hset.Err(); err != nil {
		return fmt.Errorf("hset: %w", err)
	}
	if err := expire.Err(); err != nil {
		return fmt.Errorf("expire: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Aggregation — pure, deterministic, no IO. Unit-testable on its own.
// ---------------------------------------------------------------------------

// Snapshot is the per-tick aggregated view published to Redis. Field names
// match the Redis hash field names exactly so fields() / parse on the
// consumer side stay in lock-step.
type Snapshot struct {
	ActiveUsers  int
	CPUPct       float64
	BandwidthPct float64
	PublishedAt  int64
}

// fields returns the Redis HSET payload for this snapshot. Values are
// stringified using the same encoding the TS consumer expects (Number(x) for
// numerics; ints written without a decimal point; floats with %g for compact
// round-trippable form).
func (s Snapshot) fields() map[string]any {
	return map[string]any{
		"activeUsers":  strconv.Itoa(s.ActiveUsers),
		"cpuPct":       strconv.FormatFloat(s.CPUPct, 'g', -1, 64),
		"bandwidthPct": strconv.FormatFloat(s.BandwidthPct, 'g', -1, 64),
		"publishedAt":  strconv.FormatInt(s.PublishedAt, 10),
	}
}

// aggregate produces a Snapshot from the registry. PublishedAt is left zero
// here so the time stamp can be set at the call site (publishOnce) — keeping
// aggregate() deterministic and testable without time injection.
//
// CPU and bandwidth are STUBBED AT 0 today. Accurate reporting needs:
//   - CPU: per-process %CPU from /proc/self/stat on Linux (the deployed
//     target) or equivalent runtime sampling. A coarse runtime.NumGoroutine()
//     would be misleading — leave it at 0 rather than fabricate a number.
//   - Bandwidth: aggregate of per-client BandwidthRecorder.Bandwidth(), divided
//     by MaxBandwidth * client_count. The recorder is already in cmd/grumble
//     (see bandwidth_recorder.go) but exposing it through ClientCounter would
//     widen this interface beyond just len(clients). Deferred to a follow-up
//     when the runtime team wires the actual sampling.
//
// The scheduler's scorer handles 0 metrics correctly: it scores the island on
// vServer-fill alone (placement.ts weights cpu=0.3 and bandwidth=0.2, both
// contributing 0). So a stubbed-0 reading is safer than a fabricated reading.
func aggregate(registry RegistrySnapshot) Snapshot {
	var s Snapshot
	for _, vs := range registry.List() {
		s.ActiveUsers += vs.ClientCount()
	}
	// CPUPct and BandwidthPct intentionally left at zero — see comment above.
	return s
}
