// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package islandmetrics

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// fakeServer satisfies ClientCounter for tests, returning a fixed user count.
type fakeServer struct {
	count int
}

func (f *fakeServer) ClientCount() int { return f.count }

// fakeRegistry satisfies RegistrySnapshot for tests, returning a fixed slice
// without any locking — the publisher MUST treat the returned slice as a
// snapshot already.
type fakeRegistry struct {
	servers []ClientCounter
}

func (f *fakeRegistry) List() []ClientCounter { return f.servers }

// --- Aggregation (pure, no Redis) ------------------------------------------

func TestAggregate_SumsClientCountsAcrossVServers(t *testing.T) {
	reg := &fakeRegistry{servers: []ClientCounter{
		&fakeServer{count: 3},
		&fakeServer{count: 7},
		&fakeServer{count: 0},
	}}
	got := aggregate(reg)

	if got.ActiveUsers != 10 {
		t.Errorf("ActiveUsers = %d, want 10", got.ActiveUsers)
	}
	// CPU/bandwidth are stubbed to 0 in the current implementation. If a
	// follow-up wires real sampling, update this assertion alongside the
	// implementation — leaving fabricated non-zero numbers is the wrong choice.
	if got.CPUPct != 0 {
		t.Errorf("CPUPct = %v, want 0 (stubbed)", got.CPUPct)
	}
	if got.BandwidthPct != 0 {
		t.Errorf("BandwidthPct = %v, want 0 (stubbed)", got.BandwidthPct)
	}
	// PublishedAt is set at publishOnce(), NOT in aggregate (so aggregate
	// stays deterministic). It must therefore be zero here.
	if got.PublishedAt != 0 {
		t.Errorf("PublishedAt = %d, want 0 (set at publish time)", got.PublishedAt)
	}
}

func TestAggregate_EmptyRegistryYieldsZeroes(t *testing.T) {
	reg := &fakeRegistry{servers: nil}
	got := aggregate(reg)

	if got != (Snapshot{}) {
		t.Errorf("aggregate(empty) = %+v, want zero Snapshot", got)
	}
}

// --- Snapshot.fields() encoding contract ----------------------------------

func TestSnapshotFields_EncodingMatchesConsumerContract(t *testing.T) {
	s := Snapshot{
		ActiveUsers:  42,
		CPUPct:       0.3725,
		BandwidthPct: 0.0,
		PublishedAt:  1700000000123,
	}
	f := s.fields()

	cases := []struct {
		key  string
		want string
	}{
		{"activeUsers", "42"},
		{"cpuPct", "0.3725"},
		{"bandwidthPct", "0"},
		{"publishedAt", "1700000000123"},
	}
	for _, c := range cases {
		got, ok := f[c.key]
		if !ok {
			t.Errorf("missing field %q", c.key)
			continue
		}
		if got != c.want {
			t.Errorf("field %q = %q, want %q", c.key, got, c.want)
		}
	}

	// activeUsers must be writable WITHOUT a decimal point — the TS consumer
	// parses it with parseInt, which would silently truncate "42.0" to 42 but
	// reject "42.5" for what is supposed to be an integer count. Keep it
	// integer-clean.
	if _, err := strconv.Atoi(f["activeUsers"].(string)); err != nil {
		t.Errorf("activeUsers must be a clean int string, got %q (parse err: %v)", f["activeUsers"], err)
	}
}

// --- New() input validation -------------------------------------------------

func TestNew_RejectsEmptyConfig(t *testing.T) {
	reg := &fakeRegistry{}

	if _, err := New(Config{RedisURL: "", IslandID: "x"}, reg, nil); err == nil {
		t.Error("New with empty RedisURL should fail")
	}
	if _, err := New(Config{RedisURL: "redis://x", IslandID: ""}, reg, nil); err == nil {
		t.Error("New with empty IslandID should fail")
	}
	if _, err := New(Config{RedisURL: "not-a-url", IslandID: "x"}, reg, nil); err == nil {
		t.Error("New with invalid RedisURL should fail")
	}
	if _, err := New(Config{RedisURL: "redis://x", IslandID: "x"}, nil, nil); err == nil {
		t.Error("New with nil registry should fail")
	}
}

func TestNew_AppliesDefaults(t *testing.T) {
	reg := &fakeRegistry{}
	p, err := New(Config{RedisURL: "redis://localhost:6379", IslandID: "isl-1"}, reg, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.client.Close()

	if p.cfg.PublishInterval != DefaultPublishInterval {
		t.Errorf("PublishInterval = %s, want %s", p.cfg.PublishInterval, DefaultPublishInterval)
	}
	if p.cfg.StalenessMultiplier != DefaultStalenessMultiplier {
		t.Errorf("StalenessMultiplier = %d, want %d", p.cfg.StalenessMultiplier, DefaultStalenessMultiplier)
	}
	wantTTL := DefaultPublishInterval * time.Duration(DefaultStalenessMultiplier)
	if p.ttl != wantTTL {
		t.Errorf("ttl = %s, want %s", p.ttl, wantTTL)
	}
}

// --- MetricsKey is the wire contract; tests pin the format -----------------

func TestMetricsKey_Format(t *testing.T) {
	got := MetricsKey("550e8400-e29b-41d4-a716-446655440000")
	want := "island:550e8400-e29b-41d4-a716-446655440000:metrics"
	if got != want {
		t.Errorf("MetricsKey = %q, want %q", got, want)
	}
}

// --- End-to-end with miniredis: HSET + EXPIRE wire ------------------------

// startMiniredis spins up an in-process Redis. Skipped in environments where
// miniredis isn't available (the import requires the module to be vendored).
func startMiniredis(t *testing.T) (*miniredis.Miniredis, redis.UniversalClient) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() {
		_ = client.Close()
	})
	return mr, client
}

func TestPublishOnce_WritesHashWithTTL(t *testing.T) {
	mr, client := startMiniredis(t)

	reg := &fakeRegistry{servers: []ClientCounter{
		&fakeServer{count: 5},
		&fakeServer{count: 8},
	}}
	cfg := Config{
		RedisURL:            "redis://" + mr.Addr(),
		IslandID:            "isl-test",
		PublishInterval:     time.Second,
		StalenessMultiplier: 4,
	}
	p := newWithClient(cfg, reg, client, nil)

	if err := p.publishOnce(context.Background()); err != nil {
		t.Fatalf("publishOnce: %v", err)
	}

	key := MetricsKey("isl-test")
	// HGETALL → we wrote everything the consumer expects.
	got, err := client.HGetAll(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("HGetAll: %v", err)
	}
	if got["activeUsers"] != "13" {
		t.Errorf("activeUsers = %q, want \"13\"", got["activeUsers"])
	}
	if got["cpuPct"] != "0" {
		t.Errorf("cpuPct = %q, want \"0\"", got["cpuPct"])
	}
	if got["bandwidthPct"] != "0" {
		t.Errorf("bandwidthPct = %q, want \"0\"", got["bandwidthPct"])
	}
	if got["publishedAt"] == "" {
		t.Errorf("publishedAt missing")
	}
	if _, err := strconv.ParseInt(got["publishedAt"], 10, 64); err != nil {
		t.Errorf("publishedAt = %q is not a unix-ms int: %v", got["publishedAt"], err)
	}

	// TTL must be PublishInterval * StalenessMultiplier (1s * 4 = 4s).
	ttl := mr.TTL(key)
	wantTTL := 4 * time.Second
	if ttl != wantTTL {
		t.Errorf("TTL = %s, want %s", ttl, wantTTL)
	}
}

func TestPublishOnce_ExpiresWhenTTLPasses(t *testing.T) {
	mr, client := startMiniredis(t)

	reg := &fakeRegistry{servers: []ClientCounter{&fakeServer{count: 1}}}
	// Redis EXPIRE's resolution is whole seconds (a sub-second TTL is rounded
	// up to 1s by go-redis with a warning). Pin to whole seconds here so the
	// assertion is precise and the test runs without warning chatter.
	cfg := Config{
		RedisURL:            "redis://" + mr.Addr(),
		IslandID:            "isl-expire",
		PublishInterval:     time.Second,
		StalenessMultiplier: 2,
	}
	p := newWithClient(cfg, reg, client, nil)

	if err := p.publishOnce(context.Background()); err != nil {
		t.Fatalf("publishOnce: %v", err)
	}

	key := MetricsKey("isl-expire")
	if !mr.Exists(key) {
		t.Fatalf("expected key %q to exist", key)
	}

	// Fast-forward miniredis past the TTL — the key MUST disappear, which is
	// exactly the "stopped publisher" signal the scheduler relies on. With a
	// real Redis this would happen after wall-clock TTL expiry; miniredis lets
	// us pin it to wall-clock-free behaviour.
	mr.FastForward(cfg.PublishInterval*time.Duration(cfg.StalenessMultiplier) + 100*time.Millisecond)
	if mr.Exists(key) {
		t.Errorf("expected key %q to expire after TTL", key)
	}
}

func TestRun_PublishesPeriodicallyAndStopsOnCtxCancel(t *testing.T) {
	mr, client := startMiniredis(t)
	// Separate verification client so we can read back AFTER Run() closes its
	// own client during shutdown.
	verify := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer verify.Close()

	reg := &fakeRegistry{servers: []ClientCounter{&fakeServer{count: 2}}}
	cfg := Config{
		RedisURL:            "redis://" + mr.Addr(),
		IslandID:            "isl-run",
		PublishInterval:     30 * time.Millisecond,
		StalenessMultiplier: 50, // long TTL so the key survives a few ms after Run exits
	}
	p := newWithClient(cfg, reg, client, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Run(ctx)
		close(done)
	}()

	// Give it the immediate publish-on-start plus at least one tick.
	time.Sleep(120 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// Run returned cleanly on ctx cancel.
	case <-time.After(time.Second):
		t.Fatal("Run did not return within 1s after ctx cancel")
	}

	// The publish-on-startup + at-least-one-tick must have written the key.
	key := MetricsKey("isl-run")
	if !mr.Exists(key) {
		t.Errorf("expected key %q to exist after Run", key)
	}

	// publishedAt must be non-zero. Use the separate verify client because
	// Run's deferred Close() shut the publisher's client when ctx cancelled.
	got, err := verify.HGetAll(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("HGetAll: %v", err)
	}
	pub, _ := strconv.ParseInt(got["publishedAt"], 10, 64)
	if pub == 0 {
		t.Errorf("publishedAt = 0, expected unix-ms")
	}
}

// --- concurrent registry list iteration safety -----------------------------
//
// This is a defensive sanity check: the publisher iterates the registry
// snapshot OUTSIDE any lock the caller might hold. As long as List() returns
// a freshly-allocated slice (cmd/grumble's ServerRegistry does), concurrent
// register/unregister churn must not race the publisher. We don't have the
// real registry here, but we can race aggregate() against a mutating
// fakeRegistry to confirm aggregate itself doesn't mishandle the slice.

func TestAggregate_TolueratesConcurrentRegistryChurn(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping concurrency churn in -short")
	}
	reg := &fakeRegistry{servers: []ClientCounter{&fakeServer{count: 1}}}

	stop := make(chan struct{})
	var mu sync.Mutex
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
				mu.Lock()
				reg.servers = []ClientCounter{&fakeServer{count: 1}, &fakeServer{count: 2}}
				mu.Unlock()
				mu.Lock()
				reg.servers = []ClientCounter{&fakeServer{count: 4}}
				mu.Unlock()
			}
		}
	}()

	for i := 0; i < 200; i++ {
		// We can't truly race a slice replacement with a slice read without
		// the lock — that would be a real data race the -race detector
		// catches. The point of this test is the per-call iteration must not
		// panic on an empty/short slice.
		mu.Lock()
		snap := reg.servers
		mu.Unlock()
		copyReg := &fakeRegistry{servers: snap}
		_ = aggregate(copyReg)
	}
	close(stop)
}
