// hachiman-media is the WebRTC SFU binary in the split-mode deployment.
//
// It is stateless on disk: per-session state lives in RAM and is rebuilt from
// the control plane's RoomMembershipSnapshot on sidechannel (re)connect. A
// crash drops sessions but loses no durable state.
//
// Phase 1 final pass — what lives here:
//   - sidechannel gRPC client (media → control): RegisterNode + Heartbeat +
//     SDP/ICE/session-lifecycle envelope dispatch. See sidechannel_client.go.
//   - SFU runtime: session/room state map + envelope dispatch into pkg/media.
//     See sfu_runtime.go.
//   - SFU itself: pkg/media (NewSFU, AddClient, ForwardToWebRTC, ...).
//
// Remaining for later phases:
//   - voice token verifier (validates OpenSession.voice_token at DTLS time)
//   - mTLS on the sidechannel (currently insecure-creds; dev-local)
//   - cascading peer relay (RemoteRelayedTrack)
//   - recording subscriber (apps/hachiman-recorder will connect via a
//     separate stream into the runtime)
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	a := ParseCommandLines()
	if a.ShowHelp {
		a.usage()
		return
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

	if err := run(context.Background(), logger, a); err != nil {
		logger.Fatalf("run: %v", err)
	}
}

// run owns the boot sequence and shutdown lifecycle. Subsystems threading the
// ctx are wired in here as phase 1 lands them:
//   - sidechannel gRPC server on a.SidechannelAddr
//   - sidechannel gRPC client to a.ControlAddr (RegisterNode + Heartbeat)
//   - SFU (pkg/media)
//
// Keeping this in a function (rather than open-coded in main) means the first
// subsystem PR to land already has a real ctx in scope to thread through.
func run(parent context.Context, logger *log.Logger, a args) error {
	logger.Printf("starting region=%q sidechannel-addr=%q control-addr=%q",
		a.Region, a.SidechannelAddr, a.ControlAddr)

	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	// MediaControl sidechannel client. When ControlAddr is empty the
	// embedded / standalone mode is in effect and run() is a no-op — no
	// gRPC dial, no goroutine, no Oracle registration.
	sc := newSidechannelClient(a, logger)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc.run(ctx)
	}()

	sigC := make(chan os.Signal, 1)
	signal.Notify(sigC, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigC
	logger.Printf("received %s, shutting down", sig)

	cancel()
	// L5: wait for the sidechannel goroutine to actually exit before
	// declaring shutdown complete. Without this the process could exit
	// while the sidechannel was still mid-Send and miss a clean stream
	// close from control's perspective.
	wg.Wait()
	logger.Printf("shutdown complete")
	return nil
}
