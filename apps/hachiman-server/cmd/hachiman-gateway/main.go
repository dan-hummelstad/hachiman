// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Command hachiman-gateway is the stateless realtime WebSocket gateway.
// Contract: docs/gateway-protocol.md §5–§7 and §9 (PlaceMediaSession). Sessions, resume buffers,
// presence and voice state live in Redis so any node can serve any session.
package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/coturn"
	"hachiman/server/pkg/takusenclient"
	"hachiman/server/pkg/voicetoken"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	listen := flag.String("listen", envOr("GATEWAY_LISTEN_ADDR", ":8080"), "HTTP listen address (/gateway, /healthz) (env GATEWAY_LISTEN_ADDR)")
	// Dev default = docker/docker-compose.yml; production sets DATABASE_URL.
	dbURL := flag.String("database-url", envOr("DATABASE_URL", "postgres://takusen:takusen@localhost:5432/takusen"), "Postgres URL (env DATABASE_URL)")
	redisURL := flag.String("redis-url", envOr("REDIS_URL", "redis://localhost:6379"), "Redis URL (env REDIS_URL)")
	takusenURL := flag.String("takusen-url", envOr("TAKUSEN_URL", "http://localhost:3000"), "Takusen base URL (env TAKUSEN_URL)")
	takusenGRPC := flag.String("takusen-grpc-addr", envOr("TAKUSEN_GRPC_ADDR", "127.0.0.1:50051"), "Takusen management gRPC address (env TAKUSEN_GRPC_ADDR)")
	voiceKey := flag.String("voice-key", envOr("VOICE_KEY", voicetoken.DefaultKeyPath), "Ed25519 seed file for voice tokens, created if missing (env VOICE_KEY)")
	turnSecret := flag.String("turn-secret", os.Getenv("TURN_SECRET"), "coturn static-auth-secret; empty = STUN only")
	turnURLs := flag.String("turn-urls", os.Getenv("TURN_URLS"), "comma-separated TURN URLs")
	turnTTL := flag.Duration("turn-ttl", 5*time.Minute, "TURN credential lifetime")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := pgxpool.New(ctx, *dbURL)
	must("postgres", err)
	ropts, err := redis.ParseURL(*redisURL)
	must("redis url", err)
	rdb := redis.NewClient(ropts)
	must("redis ping", rdb.Ping(ctx).Err())
	placer, err := takusenclient.New(*takusenGRPC)
	must("takusen grpc", err)
	signer, err := voicetoken.NewSigner(*voiceKey)
	must("voice signer", err)

	g := newGateway(rdb, *takusenURL, placer, signer)
	g.load = pgLoader(db)
	g.nodeURL = pgNodeURL(db)
	if *turnSecret != "" && *turnURLs != "" {
		g.turn = &coturn.CoturnRegion{Endpoints: strings.Split(*turnURLs, ","), HMACSecret: *turnSecret, CredentialTTL: *turnTTL}
	}
	go g.runBus(ctx)

	srv := &http.Server{Addr: *listen, Handler: g.routes()}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	slog.Info("hachiman-gateway listening", "addr", *listen, "takusen", *takusenURL, "takusenGrpc", *takusenGRPC, "turn", g.turn != nil)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		must("listen", err)
	}
}

func must(what string, err error) {
	if err != nil {
		slog.Error("startup failed", "step", what, "err", err)
		os.Exit(1)
	}
}
