// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// hachiman-media is the stateless WebRTC SFU for voice (Opus) and screen
// share (VP8) (contract §8).
//
//   - voice.go:  /voice WS — token identify, SDP/ICE, peers, speaking
//   - e2ee.go:   voice E2EE roster, relay and commit ordering (no MLS library)
//   - takusen.go: RegisterMediaNode + MediaNodeHeartbeat to Takusen gRPC
//   - kick.go:   Redis SUBSCRIBE media:{nodeId} → close session with 4010
//   - pkg/media: the SFU itself (room-scoped forwarding)
//
// State is RAM-only: a crash drops sessions; clients rejoin via the gateway.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/pion/webrtc/v3"
	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/media"
	"hachiman/server/pkg/takusenclient"
	"hachiman/server/pkg/voicetoken"
)

// version is stamped at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	a, err := parseArgs(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatalf("hachiman-media: %v", err)
	}
	logger := log.New(os.Stderr, "[hachiman-media] ", log.LstdFlags|log.Lmicroseconds)
	if a.LogPath != "" {
		f, err := os.OpenFile(a.LogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
		if err != nil {
			log.Fatalf("open log file: %v", err)
		}
		defer f.Close()
		logger.SetOutput(f)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, logger, a); err != nil {
		logger.Fatalf("run: %v", err)
	}
}

func run(ctx context.Context, logger *log.Logger, a args) error {
	var verifier *voicetoken.Verifier
	var err error
	if a.VoicePubKey != "" {
		verifier, err = voicetoken.NewVerifier(a.VoicePubKey, a.NodeID)
	} else {
		logger.Printf("no --voice-pubkey; using shared dev seed %s", a.VoiceKey)
		verifier, err = voicetoken.NewVerifierFromSeed(a.VoiceKey, a.NodeID)
	}
	if err != nil {
		return err
	}

	// ICE servers are handed to clients by the gateway (VOICE_SERVER_UPDATE);
	// media itself only needs STUN if it has no --public-ip.
	var ice []webrtc.ICEServer
	if a.PublicIP == "" {
		ice = []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	}
	sfu, err := media.NewSFU(media.Config{
		PublicIP:   a.PublicIP,
		UDPPortMin: uint16(a.UDPPortMin),
		UDPPortMax: uint16(a.UDPPortMax),
		ICEServers: ice,
	}, logger)
	if err != nil {
		return err
	}
	srv := newVoiceServer(sfu, verifier, logger)
	srv.readLimit = a.WSReadLimit

	opts, err := redis.ParseURL(a.RedisURL)
	if err != nil {
		return err
	}
	rdb := redis.NewClient(opts)
	defer rdb.Close()
	// close runs on SFU and pion goroutines: publish off them.
	srv.onEnd = func(c *voicetoken.Claims) { go publishVoiceDisconnected(rdb, c, logger) }

	var oc *takusenclient.Client
	if a.TakusenGRPCAddr != "" {
		if oc, err = takusenclient.New(a.TakusenGRPCAddr); err != nil {
			return err
		}
		defer oc.Close()
	} else {
		logger.Printf("WARNING: --takusen-grpc-addr empty; node will not be placeable")
	}

	mux := http.NewServeMux()
	mux.Handle("/voice", srv)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	httpSrv := &http.Server{Addr: a.Listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); runKickSubscriber(ctx, rdb, a.NodeID, srv, logger) }()
	go func() { defer wg.Done(); runTakusenRegistration(ctx, oc, a, sfu.SessionCount, logger) }()

	errC := make(chan error, 1)
	go func() { errC <- httpSrv.ListenAndServe() }()
	logger.Printf("node=%s region=%s listen=%s signaling=%s", a.NodeID, a.Region, a.Listen, a.SignalingURL)

	select {
	case err := <-errC:
		return err
	case <-ctx.Done():
	}
	logger.Printf("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx) // hijacked WS conns are not tracked by Shutdown
	srv.closeAll(1001, "node shutting down")
	wg.Wait()
	return nil
}
