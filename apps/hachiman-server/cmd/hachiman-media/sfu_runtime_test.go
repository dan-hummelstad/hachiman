// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"io"
	"log"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/pion/webrtc/v3"

	"mumble.info/grumble/pkg/mediaproto"
)

// Aliases so test helpers don't have to import pion's package name everywhere.
type webrtcSessionDescription = webrtc.SessionDescription

var (
	webrtcSDPTypeOffer = webrtc.SDPTypeOffer
)

// webrtcNewAnswerer creates a real pion PeerConnection used by tests to
// produce SDP answers against SFU-generated offers.
func webrtcNewAnswerer() (*webrtc.PeerConnection, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 97,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m))
	return api.NewPeerConnection(webrtc.Configuration{})
}

// captureSender records every outbound envelope the runtime emits. It plays
// the role of the sidechannel stream's send func without needing real gRPC.
type captureSender struct {
	mu        sync.Mutex
	envelopes []*mediaproto.Envelope
}

func (s *captureSender) send(env *mediaproto.Envelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.envelopes = append(s.envelopes, env)
	return nil
}

func (s *captureSender) snapshot() []*mediaproto.Envelope {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*mediaproto.Envelope, len(s.envelopes))
	copy(out, s.envelopes)
	return out
}

// TestSFURuntime_OpenSessionLifecycle exercises the OpenRoom → OpenSession →
// CloseSession lifecycle end-to-end. After OpenSession we expect:
//   - an SdpSignal{type:"offer"} envelope back,
//   - a SessionEstablished envelope back,
//   - the runtime's stats() reporting one active session in one active room.
//
// After CloseSession:
//   - a SessionEnded envelope with the expected reason,
//   - stats() back to zero sessions (the room sticks around until CloseRoom).
//
// Uses the REAL pkg/media.SFU — no mock — so the pion-driven offer generation
// path actually runs and we get a real SDP back.
func TestSFURuntime_OpenSessionLifecycle(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	cs := &captureSender{}
	rt.SetSender(cs.send)

	// OpenRoom is idempotent so a second one is a no-op.
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{
				RoomId:     "room-A",
				ChannelId:  1,
				HomeRegion: "us-east-test",
			},
		},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{
				RoomId: "room-A",
			},
		},
	})

	_, rooms := rt.stats()
	if rooms != 1 {
		t.Fatalf("after OpenRoom×2: rooms=%d, want 1", rooms)
	}

	// OpenSession runs the SFU and should emit SdpSignal+SessionEstablished.
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenSession{
			OpenSession: &mediaproto.OpenSession{
				SessionId: "100",
				RoomId:    "room-A",
				UserId:    "u-100",
				Ssrc:      100,
			},
		},
	})

	sessions, rooms := rt.stats()
	if sessions != 1 {
		t.Fatalf("after OpenSession: sessions=%d, want 1", sessions)
	}
	if rooms != 1 {
		t.Fatalf("after OpenSession: rooms=%d, want 1", rooms)
	}

	envs := cs.snapshot()
	// Expect at least SdpSignal+SessionEstablished. ICE candidates may also
	// appear depending on pion's gathering timing — we accept any extras as
	// long as the two we care about are present.
	var (
		gotOffer        bool
		gotEstablished  bool
		offerSessionID  string
	)
	for _, env := range envs {
		switch p := env.GetPayload().(type) {
		case *mediaproto.Envelope_SdpSignal:
			if p.SdpSignal.GetSdpType() == "offer" {
				gotOffer = true
				offerSessionID = p.SdpSignal.GetSessionId()
				if !strings.Contains(p.SdpSignal.GetSdp(), "v=0") {
					t.Errorf("offer SDP missing v=0 line; got %q", p.SdpSignal.GetSdp())
				}
			}
		case *mediaproto.Envelope_SessionEstablished:
			gotEstablished = true
			if p.SessionEstablished.GetSessionId() != "100" {
				t.Errorf("SessionEstablished session_id=%q, want \"100\"", p.SessionEstablished.GetSessionId())
			}
			if p.SessionEstablished.GetRoomId() != "room-A" {
				t.Errorf("SessionEstablished room_id=%q, want \"room-A\"", p.SessionEstablished.GetRoomId())
			}
		}
	}
	if !gotOffer {
		t.Errorf("did not emit SdpSignal{type:offer}; got %d envelopes total", len(envs))
	}
	if !gotEstablished {
		t.Errorf("did not emit SessionEstablished; got %d envelopes total", len(envs))
	}
	if offerSessionID != "100" {
		t.Errorf("offer session_id=%q, want \"100\"", offerSessionID)
	}

	// CloseSession.
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_CloseSession{
			CloseSession: &mediaproto.CloseSession{
				SessionId: "100",
			},
		},
	})

	sessions, _ = rt.stats()
	if sessions != 0 {
		t.Fatalf("after CloseSession: sessions=%d, want 0", sessions)
	}

	// Verify a SessionEnded was emitted with the disconnect reason.
	envs = cs.snapshot()
	var gotEnded bool
	for _, env := range envs {
		if p, ok := env.GetPayload().(*mediaproto.Envelope_SessionEnded); ok {
			gotEnded = true
			if p.SessionEnded.GetReason() != mediaproto.SessionEnded_REASON_CLIENT_DISCONNECT {
				t.Errorf("SessionEnded reason=%v, want REASON_CLIENT_DISCONNECT", p.SessionEnded.GetReason())
			}
		}
	}
	if !gotEnded {
		t.Error("did not emit SessionEnded after CloseSession")
	}

	// CloseRoom cleans up the room map.
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_CloseRoom{
			CloseRoom: &mediaproto.CloseRoom{RoomId: "room-A"},
		},
	})
	_, rooms = rt.stats()
	if rooms != 0 {
		t.Errorf("after CloseRoom: rooms=%d, want 0", rooms)
	}
}

// TestSFURuntime_KickSession_EmitsKickReason locks in that the KickSession
// payload triggers a SessionEnded with REASON_KICK rather than the default
// disconnect reason.
func TestSFURuntime_KickSession_EmitsKickReason(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	cs := &captureSender{}
	rt.SetSender(cs.send)

	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{RoomId: "room-K"},
		},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenSession{
			OpenSession: &mediaproto.OpenSession{
				SessionId: "200",
				RoomId:    "room-K",
				Ssrc:      200,
			},
		},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_KickSession{
			KickSession: &mediaproto.KickSession{
				SessionId: "200",
				Reason:    "admin-banned",
			},
		},
	})

	envs := cs.snapshot()
	var got bool
	for _, env := range envs {
		if p, ok := env.GetPayload().(*mediaproto.Envelope_SessionEnded); ok {
			got = true
			if p.SessionEnded.GetReason() != mediaproto.SessionEnded_REASON_KICK {
				t.Errorf("Kick → SessionEnded.reason=%v, want REASON_KICK", p.SessionEnded.GetReason())
			}
		}
	}
	if !got {
		t.Error("did not emit SessionEnded after Kick")
	}
}

// TestSFURuntime_RenegotiatesExistingPeersOnJoin locks in CRITICAL #3: when
// a new session joins an existing room, every other session in the room
// MUST receive a fresh SDP offer. Otherwise pion has the joiner's output
// track in its send list but never advertises it — second-and-onward users
// stay silent.
//
// pion rejects CreateOffer in `have-local-offer` state, so to simulate a
// realistic in-call client the test feeds back a synthetic SDP answer after
// each initial offer. The answer is built from the matching `helper` peer
// connection (a real pion PC running just inside the test) so it lines up
// with the SFU's transceivers/m-lines.
func TestSFURuntime_RenegotiatesExistingPeersOnJoin(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	cs := &captureSender{}
	rt.SetSender(cs.send)

	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{RoomId: "room-R"},
		},
	})

	openAndAnswer := func(id string) {
		baseEnvCount := len(cs.snapshot())
		rt.HandleEnvelope(&mediaproto.Envelope{
			Payload: &mediaproto.Envelope_OpenSession{
				OpenSession: &mediaproto.OpenSession{
					SessionId: id,
					RoomId:    "room-R",
					Ssrc:      uint32(mustParseUint(id)),
				},
			},
		})
		// Locate the initial offer for THIS session in the envelopes that
		// appeared after this OpenSession call, then post back a synthetic
		// answer so pion returns to `stable` state. The renegotiation
		// offers for OTHER sessions also need answers; we hit those below
		// in a second pass.
		envs := cs.snapshot()[baseEnvCount:]
		for _, env := range envs {
			sig, ok := env.GetPayload().(*mediaproto.Envelope_SdpSignal)
			if !ok {
				continue
			}
			if sig.SdpSignal.GetSdpType() != "offer" {
				continue
			}
			answer, ok := buildAnswerForOffer(t, sig.SdpSignal.GetSdp())
			if !ok {
				continue
			}
			rt.HandleEnvelope(&mediaproto.Envelope{
				Payload: &mediaproto.Envelope_SdpSignal{
					SdpSignal: &mediaproto.SdpSignal{
						SessionId: sig.SdpSignal.GetSessionId(),
						SdpType:   "answer",
						Sdp:       answer,
					},
				},
			})
		}
	}

	for _, id := range []string{"1", "2", "3"} {
		openAndAnswer(id)
	}

	// Count the SDP offers per session id. Session "1" should receive 2
	// renegotiation offers (once when "2" joined, once when "3" joined).
	// Session "2" should receive 1 (when "3" joined). Session "3" gets
	// only its initial offer.
	offerCounts := map[string]int{}
	for _, env := range cs.snapshot() {
		sig, ok := env.GetPayload().(*mediaproto.Envelope_SdpSignal)
		if !ok {
			continue
		}
		if sig.SdpSignal.GetSdpType() != "offer" {
			continue
		}
		offerCounts[sig.SdpSignal.GetSessionId()]++
	}

	if got := offerCounts["1"]; got != 3 {
		t.Errorf("session 1 received %d offers, want 3 (1 initial + 2 renegotiations)", got)
	}
	if got := offerCounts["2"]; got != 2 {
		t.Errorf("session 2 received %d offers, want 2 (1 initial + 1 renegotiation)", got)
	}
	if got := offerCounts["3"]; got != 1 {
		t.Errorf("session 3 received %d offers, want 1 (initial only)", got)
	}
}

// buildAnswerForOffer creates a synthetic SDP answer for an offer using a
// throwaway pion PeerConnection. This lets renegotiation tests drive a real
// pion state machine into `stable` state without needing a full client.
func buildAnswerForOffer(t *testing.T, offerSDP string) (string, bool) {
	t.Helper()
	helper, err := webrtcNewAnswerer()
	if err != nil {
		t.Logf("buildAnswerForOffer: new helper PC: %v", err)
		return "", false
	}
	defer helper.Close()
	if err := helper.SetRemoteDescription(webrtcSessionDescription{Type: webrtcSDPTypeOffer, SDP: offerSDP}); err != nil {
		t.Logf("buildAnswerForOffer: SetRemoteDescription: %v", err)
		return "", false
	}
	answer, err := helper.CreateAnswer(nil)
	if err != nil {
		t.Logf("buildAnswerForOffer: CreateAnswer: %v", err)
		return "", false
	}
	if err := helper.SetLocalDescription(answer); err != nil {
		t.Logf("buildAnswerForOffer: SetLocalDescription: %v", err)
		return "", false
	}
	return answer.SDP, true
}

// TestSFURuntime_DuplicateOpenSessionTearsDownPrevious locks in HIGH #5:
// re-issuing OpenSession for an already-known session_id tears the old
// peer down before installing the new one. Without this the previous
// PeerConnection leaks.
func TestSFURuntime_DuplicateOpenSessionTearsDownPrevious(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	cs := &captureSender{}
	rt.SetSender(cs.send)

	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{RoomId: "room-D"},
		},
	})
	// Open the same session twice in a row.
	for i := 0; i < 2; i++ {
		rt.HandleEnvelope(&mediaproto.Envelope{
			Payload: &mediaproto.Envelope_OpenSession{
				OpenSession: &mediaproto.OpenSession{
					SessionId: "55",
					RoomId:    "room-D",
					Ssrc:      55,
				},
			},
		})
	}

	sessions, _ := rt.stats()
	if sessions != 1 {
		t.Errorf("after duplicate OpenSession: sessions=%d, want 1", sessions)
	}

	// The teardown of the first session emits a SessionEnded between the
	// first and second OpenSession's SdpSignal. Verify by counting both.
	var (
		gotEnded  int
		gotOffers int
	)
	for _, env := range cs.snapshot() {
		switch p := env.GetPayload().(type) {
		case *mediaproto.Envelope_SessionEnded:
			if p.SessionEnded.GetSessionId() == "55" {
				gotEnded++
			}
		case *mediaproto.Envelope_SdpSignal:
			if p.SdpSignal.GetSdpType() == "offer" && p.SdpSignal.GetSessionId() == "55" {
				gotOffers++
			}
		}
	}
	if gotEnded < 1 {
		t.Errorf("expected at least one SessionEnded for the torn-down peer; got %d", gotEnded)
	}
	if gotOffers != 2 {
		t.Errorf("expected 2 SDP offers (one per OpenSession); got %d", gotOffers)
	}
}

// TestSFURuntime_SessionMoveTransfersRoom locks in HIGH #3: a SessionMove
// envelope moves the session_id between r.rooms entries; subsequent voice
// fanout follows the new room.
func TestSFURuntime_SessionMoveTransfersRoom(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	rt.SetSender((&captureSender{}).send)

	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{OpenRoom: &mediaproto.OpenRoom{RoomId: "A"}},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{OpenRoom: &mediaproto.OpenRoom{RoomId: "B"}},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenSession{
			OpenSession: &mediaproto.OpenSession{
				SessionId: "9",
				RoomId:    "A",
				Ssrc:      9,
			},
		},
	})

	// Verify session is in room A.
	rt.mu.RLock()
	_, inA := rt.rooms["A"]["9"]
	rt.mu.RUnlock()
	if !inA {
		t.Fatal("session 9 should be in room A after OpenSession")
	}

	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SessionMove{
			SessionMove: &mediaproto.SessionMove{
				SessionId:  "9",
				OldRoomId:  "A",
				NewRoomId:  "B",
			},
		},
	})

	rt.mu.RLock()
	_, stillInA := rt.rooms["A"]["9"]
	_, inB := rt.rooms["B"]["9"]
	state := rt.sessions["9"]
	rt.mu.RUnlock()
	if stillInA {
		t.Error("session 9 still in room A after SessionMove")
	}
	if !inB {
		t.Error("session 9 not in room B after SessionMove")
	}
	if state == nil || state.roomID != "B" {
		t.Errorf("sessionState.roomID = %q, want \"B\"", state.roomID)
	}

	// Idempotency: SessionMove with old == new is a no-op.
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SessionMove{
			SessionMove: &mediaproto.SessionMove{SessionId: "9", OldRoomId: "B", NewRoomId: "B"},
		},
	})
	rt.mu.RLock()
	_, stillInB := rt.rooms["B"]["9"]
	rt.mu.RUnlock()
	if !stillInB {
		t.Error("session 9 should still be in room B after no-op SessionMove")
	}
}

// TestSFURuntime_ICEEndOfCandidatesSentinel locks in MEDIUM #4: pion's nil
// ICE candidate (end-of-candidates) is forwarded as an empty-string
// candidate_json sentinel rather than dropped on the floor.
func TestSFURuntime_ICEEndOfCandidatesSentinel(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	cs := &captureSender{}
	rt.SetSender(cs.send)

	// Direct call into forwardServerICECandidate with nil simulates
	// pion's gatherer firing its EOC.
	rt.forwardServerICECandidate("123", nil)

	envs := cs.snapshot()
	var gotEOC bool
	for _, env := range envs {
		sig, ok := env.GetPayload().(*mediaproto.Envelope_IceCandidateSignal)
		if !ok {
			continue
		}
		if sig.IceCandidateSignal.GetSessionId() == "123" && sig.IceCandidateSignal.GetCandidateJson() == "" {
			gotEOC = true
		}
	}
	if !gotEOC {
		t.Errorf("expected an empty-candidate_json EOC sentinel; got %d envelopes", len(envs))
	}
}

// mustParseUint is a tiny helper for tests where parse failure would mean
// the test fixture itself is broken.
func mustParseUint(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		panic(err)
	}
	return v
}

// TestSFURuntime_HeartbeatStatsAreReal locks in follow-up #9 partial: the
// heartbeat's ActiveSessions / ActiveRooms now reflect real counts from the
// runtime's maps, not hardcoded zeros.
func TestSFURuntime_HeartbeatStatsAreReal(t *testing.T) {
	logger := log.New(io.Discard, "[test] ", 0)
	rt := newSFURuntime(logger, "us-east-test")
	rt.SetSender((&captureSender{}).send)

	if s, r := rt.stats(); s != 0 || r != 0 {
		t.Fatalf("fresh runtime stats: sessions=%d rooms=%d, want 0,0", s, r)
	}

	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{RoomId: "r1"},
		},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenRoom{
			OpenRoom: &mediaproto.OpenRoom{RoomId: "r2"},
		},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenSession{
			OpenSession: &mediaproto.OpenSession{SessionId: "1", RoomId: "r1", Ssrc: 1},
		},
	})
	rt.HandleEnvelope(&mediaproto.Envelope{
		Payload: &mediaproto.Envelope_OpenSession{
			OpenSession: &mediaproto.OpenSession{SessionId: "2", RoomId: "r2", Ssrc: 2},
		},
	})

	s, r := rt.stats()
	if s != 2 {
		t.Errorf("after 2 sessions: stats sessions=%d, want 2", s)
	}
	if r != 2 {
		t.Errorf("after 2 rooms: stats rooms=%d, want 2", r)
	}
}
