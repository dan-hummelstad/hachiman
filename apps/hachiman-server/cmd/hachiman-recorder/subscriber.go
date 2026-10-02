// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"hachiman/server/pkg/recorderproto"
)

// Phase 3a recorder scaffold — SubscribeAsRecorder client loop.
//
// The subscriber dials a media node's RecorderControl gRPC service, opens a
// server-streaming SubscribeAsRecorder RPC, and receives RecorderEvent
// envelopes in a loop. Phase 3a logs each envelope's metadata (track id,
// codec, e2ee epoch, etc.) and discards payload; real segment writes land
// with the recording runtime in phase 4.
//
// Reconnect uses the same exponential-jittered backoff as hachiman-media's
// sidechannel client: 1s → 30s with ±25% jitter; reset to the minimum on
// every successful stream (one that stayed open longer than the heartbeat
// cadence). Sharing the math is a deliberate choice — see the comment on
// subscribeReconnectBackoffMin below — but no code is shared yet because
// hachiman-media holds its copy under internal package scope.

const (
	// subscribeReconnectBackoffMin / Max bracket the exponential backoff
	// between reconnect attempts. Numbers match
	// sidechannelReconnectBackoffMin / Max in cmd/hachiman-media — phase 3a
	// keeps them as two constants in two binaries so the recorder doesn't
	// pull a dependency on internal media helpers. If/when we factor a
	// shared backoff helper out (likely once a third binary lands), this
	// constant moves there.
	subscribeReconnectBackoffMin = 1 * time.Second
	subscribeReconnectBackoffMax = 30 * time.Second

	// subscribeBackoffResetWindow is the minimum stream duration that
	// counts as a "successful" connection — exiting that fast resets
	// backoff to the floor. Matches the heartbeat cadence on
	// hachiman-media's sidechannel so a recorder that survives at least
	// one stream-heartbeat cycle is treated the same way.
	subscribeBackoffResetWindow = 10 * time.Second
)

// envelopeHandler is the per-envelope hook. Tests inject a recorder; the
// production loop logs and discards. Returning an error halts the loop and
// surfaces back to the reconnect-retry layer in run().
type envelopeHandler func(*recorderproto.RecorderEvent) error

// subscriber owns the dial → subscribe → recv loop. One subscriber instance
// per process; the loop is restarted by run() on every reconnect attempt.
type subscriber struct {
	mediaAddr          string
	roomID             string
	recorderID         string
	recorderCredential []byte
	logger             *log.Logger

	// handler is the per-envelope callback. Tests replace it; production
	// uses logEnvelope. Nil falls through to a logger-driven default.
	handler envelopeHandler

	// dialer is the gRPC client constructor. Tests inject a mock that
	// dials a local server; production calls grpc.NewClient with insecure
	// creds. mTLS lands with the same dev-cert provisioning the
	// hachiman-media sidechannel waits for (follow-up #10 there).
	dialer func(ctx context.Context, addr string) (*grpc.ClientConn, error)
}

// newSubscriber constructs a subscriber with production defaults: the gRPC
// client uses insecure-creds (phase 3a; mTLS lands later) and envelope
// handling logs metadata then drops payload.
func newSubscriber(a args, logger *log.Logger) *subscriber {
	s := &subscriber{
		mediaAddr:          a.MediaAddr,
		roomID:             a.RoomID,
		recorderID:         fmt.Sprintf("recorder-%s", a.Region),
		recorderCredential: []byte(a.RecorderCredential),
		logger:             logger,
		dialer:             defaultDialer,
	}
	s.handler = s.logEnvelope
	return s
}

// defaultDialer is the production gRPC client constructor. Splitting it out
// lets tests inject a dial against the in-process test server without the
// addr-parsing dance.
func defaultDialer(ctx context.Context, addr string) (*grpc.ClientConn, error) {
	_ = ctx // grpc.NewClient is lazy — no dial in this call
	return grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
}

// run drives the connect → subscribe → recv loop until ctx is cancelled.
// Each iteration is one connection attempt; failures back off exponentially
// (capped, jittered) and retry. A successful stream that stayed open at
// least subscribeBackoffResetWindow resets backoff to the floor.
func (s *subscriber) run(ctx context.Context) {
	if s.mediaAddr == "" || s.roomID == "" {
		// Boot-test mode — log and exit cleanly. main()'s shutdown path
		// still runs because the signal handler is set up before run().
		s.logger.Printf("[subscriber] media-addr or room-id unset; boot-test mode (no subscription)")
		return
	}

	// rng is goroutine-local; the run loop is single-threaded so no lock
	// needed. Seed from time.Now so two recorders starting in lockstep
	// don't synchronise their jitter.
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	backoff := subscribeReconnectBackoffMin

	for {
		if ctx.Err() != nil {
			return
		}
		start := time.Now()
		err := s.runOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			s.logger.Printf("[subscriber] stream ended: %v", err)
		}
		if time.Since(start) >= subscribeBackoffResetWindow {
			backoff = subscribeReconnectBackoffMin
		} else {
			backoff = nextBackoff(backoff, rng)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}

// runOnce dials the media node, opens SubscribeAsRecorder, and receives
// envelopes until the stream ends or ctx is cancelled. Returns the error
// that ended the stream (nil for ctx-cancel / clean EOF).
func (s *subscriber) runOnce(ctx context.Context) error {
	conn, err := s.dialer(ctx, s.mediaAddr)
	if err != nil {
		return fmt.Errorf("dial %q: %w", s.mediaAddr, err)
	}
	defer conn.Close()

	client := recorderproto.NewRecorderControlClient(conn)
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream, err := client.SubscribeAsRecorder(streamCtx, &recorderproto.SubscribeAsRecorderRequest{
		RoomId:             s.roomID,
		RecorderCredential: s.recorderCredential,
		RecorderId:         s.recorderID,
	})
	if err != nil {
		return fmt.Errorf("subscribe as recorder: %w", err)
	}
	s.logger.Printf("[subscriber] subscribed room=%s media=%s recorder=%s",
		s.roomID, s.mediaAddr, s.recorderID)

	for {
		ev, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return fmt.Errorf("recv: %w", err)
		}
		if s.handler != nil {
			if hErr := s.handler(ev); hErr != nil {
				return fmt.Errorf("handler: %w", hErr)
			}
		}
	}
}

// logEnvelope is the default per-envelope handler — prints a one-line summary
// of the event metadata and discards payload. Phase 4 swaps this for the
// segment-writer pipeline; the handler signature is stable so the swap is
// a one-line change.
func (s *subscriber) logEnvelope(ev *recorderproto.RecorderEvent) error {
	switch p := ev.GetPayload().(type) {
	case *recorderproto.RecorderEvent_EncodedFrame:
		f := p.EncodedFrame
		s.logger.Printf("[subscriber] frame track=%s codec=%s ssrc=%d keyframe=%t rtp_ts=%d wallclock_us=%d payload_bytes=%d e2ee_epoch=%d e2ee_key_id=%d",
			f.GetTrackId(), f.GetCodec(), f.GetOriginatingSsrc(), f.GetIsKeyframe(),
			f.GetRtpTimestamp(), f.GetReceivedAtUnixMicros(), len(f.GetPayload()),
			f.GetE2EeEpoch(), f.GetE2EeKeyId())
	case *recorderproto.RecorderEvent_TrackAdded:
		t := p.TrackAdded
		s.logger.Printf("[subscriber] track_added track=%s kind=%s codec=%s ssrc=%d publisher=%s",
			t.GetTrackId(), t.GetKind(), t.GetCodec(), t.GetOriginatingSsrc(), t.GetPublisherSessionId())
	case *recorderproto.RecorderEvent_TrackRemoved:
		s.logger.Printf("[subscriber] track_removed track=%s", p.TrackRemoved.GetTrackId())
	case *recorderproto.RecorderEvent_EpochAdvanced:
		s.logger.Printf("[subscriber] epoch_advanced room=%s new_epoch=%d",
			p.EpochAdvanced.GetRoomId(), p.EpochAdvanced.GetNewEpoch())
	case *recorderproto.RecorderEvent_Heartbeat:
		s.logger.Printf("[subscriber] heartbeat sent_at_us=%d", p.Heartbeat.GetSentAtUnixMicros())
	}
	return nil
}

// nextBackoff returns the next backoff duration, capped at the configured max
// and shaken by ±25% jitter. Mirrors the same-named helper in
// cmd/hachiman-media/sidechannel_client.go.
func nextBackoff(cur time.Duration, rng *rand.Rand) time.Duration {
	next := cur * 2
	if next > subscribeReconnectBackoffMax {
		next = subscribeReconnectBackoffMax
	}
	jitter := (rng.Float64() - 0.5) * 0.5 // ±0.25
	d := time.Duration(float64(next) * (1.0 + jitter))
	if d < subscribeReconnectBackoffMin {
		d = subscribeReconnectBackoffMin
	}
	return d
}
