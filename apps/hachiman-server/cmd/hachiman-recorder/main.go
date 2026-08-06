// hachiman-recorder is the recording subscriber binary in the split-mode
// deployment. It dials a media node's RecorderControl gRPC service, opens a
// SubscribeAsRecorder server-streaming RPC for a single room, and (in phase
// 3a) logs each received frame's metadata while discarding payload.
//
// Phase 3a scope: scaffold only — flags, signal handling, reconnect loop,
// envelope handler, in-process test coverage. The actual S3 segment writer
// lands with the recording runtime in phase 4.
//
// What lives here:
//   - args.go             — CLI surface (region, media-addr, room-id, etc.)
//   - subscriber.go       — SubscribeAsRecorder client loop + envelope handler
//   - main.go (this file) — boot sequence, signal handling, shutdown wait
//   - subscriber_test.go  — in-process gRPC fake exercising the recv loop
//
// Remaining for later phases:
//   - segment encoder + S3 writer (phase 4)
//   - mTLS on the SubscribeAsRecorder dial (currently insecure-creds)
//   - recorder-credential minting + verification (phase 4)
//   - multi-room batching (phase 4)
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

	logger := log.New(os.Stderr, "[hachiman-recorder] ", log.LstdFlags|log.Lmicroseconds)
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

// run owns the boot sequence and shutdown lifecycle. Threading ctx through
// every subsystem means SIGINT / SIGTERM unwinds the whole tree.
func run(parent context.Context, logger *log.Logger, a args) error {
	logger.Printf("starting region=%q media-addr=%q room-id=%q s3-bucket=%q",
		a.Region, a.MediaAddr, a.RoomID, a.S3Bucket)

	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	sub := newSubscriber(a, logger)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sub.run(ctx)
	}()

	sigC := make(chan os.Signal, 1)
	signal.Notify(sigC, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigC:
		logger.Printf("received %s, shutting down", sig)
	case <-ctx.Done():
		logger.Printf("context cancelled, shutting down")
	}

	cancel()
	wg.Wait()
	logger.Printf("shutdown complete")
	return nil
}
