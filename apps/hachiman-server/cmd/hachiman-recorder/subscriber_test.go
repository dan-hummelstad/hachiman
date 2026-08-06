// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"mumble.info/grumble/pkg/recorderproto"
)

// TestSubscriber_ReceivesEnvelopesInOrder spins up a fake RecorderControl
// gRPC server on 127.0.0.1:0, runs the subscriber against it, pushes three
// synthetic RecorderFrame envelopes, and asserts the subscriber's handler
// receives them in order. Covers the production runOnce path end-to-end
// (codegen, serialization, server-streaming semantics).
func TestSubscriber_ReceivesEnvelopesInOrder(t *testing.T) {
	logger := log.New(os.Stderr, "[test] ", 0)

	// Three synthetic frames in known order — the assertion compares the
	// track_id field to confirm in-order delivery.
	frames := []*recorderproto.RecorderEvent{
		{
			Payload: &recorderproto.RecorderEvent_TrackAdded{
				TrackAdded: &recorderproto.TrackAdded{
					TrackId:            "track-1",
					PublisherSessionId: "session-1",
					Kind:               "voice",
					Codec:              "opus",
					OriginatingSsrc:    1,
				},
			},
		},
		{
			Payload: &recorderproto.RecorderEvent_EncodedFrame{
				EncodedFrame: &recorderproto.EncodedFrame{
					TrackId:              "track-1",
					OriginatingSsrc:      1,
					PublisherSessionId:   "session-1",
					Codec:                "opus",
					RtpTimestamp:         1000,
					ReceivedAtUnixMicros: 1_700_000_000_000_000,
					Payload:              []byte{0x01, 0x02, 0x03},
					IsKeyframe:           true,
					E2EeEpoch:            0,
					E2EeKeyId:            0,
				},
			},
		},
		{
			Payload: &recorderproto.RecorderEvent_EncodedFrame{
				EncodedFrame: &recorderproto.EncodedFrame{
					TrackId:              "track-1",
					OriginatingSsrc:      1,
					PublisherSessionId:   "session-1",
					Codec:                "opus",
					RtpTimestamp:         2000,
					ReceivedAtUnixMicros: 1_700_000_000_020_000,
					Payload:              []byte{0x04, 0x05},
					IsKeyframe:           false,
				},
			},
		},
	}

	fake := &fakeRecorderServer{frames: frames}
	addr, stopServer := startFakeRecorderServer(t, fake)
	defer stopServer()

	// Build the subscriber with a dialer that points at the fake; the
	// handler appends each envelope into a slice we then assert against.
	var (
		mu         sync.Mutex
		received   []*recorderproto.RecorderEvent
		gotAllFn   = make(chan struct{})
		doneClosed bool
	)
	sub := &subscriber{
		mediaAddr:          addr,
		roomID:             "room-42",
		recorderID:         "recorder-test",
		recorderCredential: []byte("dev-credential"),
		logger:             logger,
		dialer:             defaultDialer,
	}
	sub.handler = func(ev *recorderproto.RecorderEvent) error {
		mu.Lock()
		received = append(received, ev)
		n := len(received)
		mu.Unlock()
		if n == len(frames) && !doneClosed {
			doneClosed = true
			close(gotAllFn)
		}
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		// runOnce returns when the server closes the stream after the
		// last envelope — the fake's SubscribeAsRecorder ends with a
		// nil return which the gRPC layer translates to clean EOF.
		_ = sub.runOnce(ctx)
	}()

	select {
	case <-gotAllFn:
	case <-ctx.Done():
		t.Fatalf("timeout waiting for envelopes; got %d / %d", len(received), len(frames))
	}

	// Don't race the goroutine on slice access.
	cancel()
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()

	if len(received) != len(frames) {
		t.Fatalf("got %d envelopes, want %d", len(received), len(frames))
	}
	// Track id is the easiest cross-payload-type assertion: all three
	// frames in this test carry "track-1" so we instead check the payload
	// type sequence + the embedded counters to confirm order.
	if _, ok := received[0].GetPayload().(*recorderproto.RecorderEvent_TrackAdded); !ok {
		t.Fatalf("envelope 0: want TrackAdded, got %T", received[0].GetPayload())
	}
	first, ok := received[1].GetPayload().(*recorderproto.RecorderEvent_EncodedFrame)
	if !ok {
		t.Fatalf("envelope 1: want EncodedFrame, got %T", received[1].GetPayload())
	}
	second, ok := received[2].GetPayload().(*recorderproto.RecorderEvent_EncodedFrame)
	if !ok {
		t.Fatalf("envelope 2: want EncodedFrame, got %T", received[2].GetPayload())
	}
	if first.EncodedFrame.GetRtpTimestamp() != 1000 {
		t.Errorf("envelope 1 rtp_timestamp: got %d, want 1000", first.EncodedFrame.GetRtpTimestamp())
	}
	if second.EncodedFrame.GetRtpTimestamp() != 2000 {
		t.Errorf("envelope 2 rtp_timestamp: got %d, want 2000", second.EncodedFrame.GetRtpTimestamp())
	}

	// Also verify the request that reached the fake server carries the
	// expected room id + recorder id — confirms the client side encoded
	// the request correctly.
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.lastRequest == nil {
		t.Fatal("fake server never observed a SubscribeAsRecorder request")
	}
	if fake.lastRequest.GetRoomId() != "room-42" {
		t.Errorf("fake server saw room_id=%q, want %q", fake.lastRequest.GetRoomId(), "room-42")
	}
	if fake.lastRequest.GetRecorderId() != "recorder-test" {
		t.Errorf("fake server saw recorder_id=%q, want %q", fake.lastRequest.GetRecorderId(), "recorder-test")
	}
	if string(fake.lastRequest.GetRecorderCredential()) != "dev-credential" {
		t.Errorf("fake server saw recorder_credential=%q, want %q",
			string(fake.lastRequest.GetRecorderCredential()), "dev-credential")
	}
}

// TestSubscriber_BootTestMode locks in the contract that an unconfigured
// recorder (no media-addr, no room-id) exits run() without dialing or
// crashing — the boot-test path used by container smoke tests.
func TestSubscriber_BootTestMode(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	sub := &subscriber{
		mediaAddr:  "",
		roomID:     "",
		logger:     logger,
		dialer:     defaultDialer,
		handler:    func(*recorderproto.RecorderEvent) error { return nil },
		recorderID: "recorder-boot-test",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		sub.run(ctx)
	}()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("boot-test mode did not exit run() promptly")
	}
}

// fakeRecorderServer implements RecorderControlServer. It records the
// inbound request and pushes a fixed list of envelopes back over the stream.
type fakeRecorderServer struct {
	recorderproto.UnimplementedRecorderControlServer

	frames []*recorderproto.RecorderEvent

	mu          sync.Mutex
	lastRequest *recorderproto.SubscribeAsRecorderRequest
}

func (f *fakeRecorderServer) SubscribeAsRecorder(req *recorderproto.SubscribeAsRecorderRequest,
	stream grpc.ServerStreamingServer[recorderproto.RecorderEvent]) error {
	f.mu.Lock()
	f.lastRequest = req
	f.mu.Unlock()
	for _, ev := range f.frames {
		if err := stream.Send(ev); err != nil {
			return err
		}
	}
	return nil
}

// startFakeRecorderServer binds a gRPC server on 127.0.0.1:0 and registers
// the fake. Returns the bound addr and a stop func that callers defer to
// teardown.
func startFakeRecorderServer(t *testing.T, fake *fakeRecorderServer) (string, func()) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	recorderproto.RegisterRecorderControlServer(gs, fake)
	go func() {
		_ = gs.Serve(lis)
	}()
	return lis.Addr().String(), func() {
		gs.GracefulStop()
		_ = lis.Close()
	}
}

// Compile-time guard: the production dialer satisfies the subscriber's dialer
// field shape. Catches a signature drift at build time.
var _ func(context.Context, string) (*grpc.ClientConn, error) = defaultDialer

// Compile-time guard: the production handler signature matches envelopeHandler.
// Keeps the signature stable when the phase-4 segment writer drops in.
var _ envelopeHandler = (&subscriber{}).logEnvelope

// _ keeps the insecure-creds import live — used only via the default dialer,
// which the linter would otherwise flag as unused.
var _ = insecure.NewCredentials
