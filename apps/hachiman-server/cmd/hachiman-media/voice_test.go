// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v3"
	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/media"
	"hachiman/server/pkg/voicetoken"
)

const testNode = "node-test"

type harness struct {
	t      *testing.T
	signer *voicetoken.Signer
	srv    *voiceServer
	url    string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	seed := filepath.Join(t.TempDir(), "voice.ed25519")
	signer, err := voicetoken.NewSigner(seed)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := voicetoken.NewVerifierFromSeed(seed, testNode)
	if err != nil {
		t.Fatal(err)
	}
	logger := log.New(io.Discard, "", 0)
	if testing.Verbose() {
		logger = log.New(log.Writer(), "[media-test] ", log.Lmicroseconds)
	}
	sfu, err := media.NewSFU(media.Config{IncludeLoopback: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	srv := newVoiceServer(sfu, verifier, logger)
	hs := httptest.NewServer(srv)
	t.Cleanup(func() { srv.closeAll(1001, "test done"); hs.Close() })
	return &harness{t: t, signer: signer, srv: srv, url: "ws" + strings.TrimPrefix(hs.URL, "http")}
}

func (h *harness) token(session, user, channel string) string {
	h.t.Helper()
	tok, err := h.signer.Mint(voicetoken.Claims{SessionID: session, UserID: user, GuildID: "g1", ChannelID: channel, MediaNodeID: testNode})
	if err != nil {
		h.t.Fatal(err)
	}
	return tok
}

// wsClient reads frames on a background goroutine: gorilla read errors
// (including deadlines) are permanent, so "expect silence" can't use them.
type wsClient struct {
	t      *testing.T
	ws     *websocket.Conn
	frames chan frame
	closed chan error // the terminal read error
}

func (h *harness) dial(token string) *wsClient {
	h.t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial(h.url, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { ws.Close() })
	c := &wsClient{t: h.t, ws: ws, frames: make(chan frame, 256), closed: make(chan error, 1)}
	go func() {
		for {
			var f frame
			if err := ws.ReadJSON(&f); err != nil {
				c.closed <- err
				return
			}
			c.frames <- f
		}
	}()
	if token != "" {
		c.send("identify", map[string]string{"token": token})
	}
	return c
}

func (c *wsClient) send(op string, d any) {
	c.t.Helper()
	if err := c.ws.WriteJSON(map[string]any{"op": op, "d": d}); err != nil {
		c.t.Fatal(err)
	}
}

// next returns the next frame with the given op, skipping candidate frames.
func (c *wsClient) next(op string) json.RawMessage {
	c.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case f := <-c.frames:
			if f.Op == op {
				return f.D
			}
			if f.Op != "candidate" {
				c.t.Fatalf("waiting for %q, got %q: %s", op, f.Op, f.D)
			}
		case err := <-c.closed:
			c.t.Fatalf("waiting for %q: %v", op, err)
		case <-timeout:
			c.t.Fatalf("timed out waiting for %q", op)
		}
	}
}

// quiet asserts nothing but candidates arrives within d.
func (c *wsClient) quiet(d time.Duration) {
	c.t.Helper()
	timeout := time.After(d)
	for {
		select {
		case f := <-c.frames:
			if f.Op != "candidate" {
				c.t.Fatalf("expected silence, got %q: %s", f.Op, f.D)
			}
		case err := <-c.closed:
			c.t.Fatalf("quiet: %v", err)
		case <-timeout:
			return
		}
	}
}

// closeCode drains frames until the server closes, returning the close code.
func (c *wsClient) closeCode() int {
	c.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case <-c.frames:
		case err := <-c.closed:
			var ce *websocket.CloseError
			if errors.As(err, &ce) {
				return ce.Code
			}
			c.t.Fatalf("expected close frame, got %v", err)
		case <-timeout:
			c.t.Fatal("timed out waiting for close")
		}
	}
}

func (c *wsClient) peers() []peerInfo {
	c.t.Helper()
	var d struct{ Peers []peerInfo }
	if err := json.Unmarshal(c.next("peers"), &d); err != nil {
		c.t.Fatal(err)
	}
	return d.Peers
}

func (c *wsClient) offer() string {
	c.t.Helper()
	var d struct{ SDP string }
	if err := json.Unmarshal(c.next("offer"), &d); err != nil {
		c.t.Fatal(err)
	}
	return d.SDP
}

// pionPeer is the test's stand-in for the browser: answers every offer,
// uploads its mic on m-line 0 and trickles candidates.
type pionPeer struct {
	pc  *webrtc.PeerConnection
	mic *webrtc.TrackLocalStaticRTP
	ws  *wsClient
}

func newPionPeer(t *testing.T, ws *wsClient) *pionPeer {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	mic, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "mic")
	// Added before the first remote offer so pion pairs it with media's
	// recvonly m-line 0 (the browser does the same via transceivers[0]).
	if _, err := pc.AddTrack(mic); err != nil {
		t.Fatal(err)
	}
	p := &pionPeer{pc: pc, mic: mic, ws: ws}
	return p
}

func (p *pionPeer) answer(t *testing.T, sdp string) {
	t.Helper()
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		t.Fatal(err)
	}
	ans, err := p.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(ans); err != nil {
		t.Fatal(err)
	}
	<-gathered // non-trickle on the test side keeps the WS writer single-goroutine
	p.ws.send("answer", map[string]string{"sdp": p.pc.LocalDescription().SDP})
}

func TestVoice_JoinPeersRenegotiateAndRoomScoping(t *testing.T) {
	h := newHarness(t)

	a := h.dial(h.token("sA", "userA", "room1"))
	var ready struct {
		SessionID string `json:"sessionId"`
		SSRC      uint32 `json:"ssrc"`
	}
	if err := json.Unmarshal(a.next("ready"), &ready); err != nil || ready.SessionID != "sA" || ready.SSRC == 0 {
		t.Fatalf("ready = %+v, %v", ready, err)
	}
	if ps := a.peers(); len(ps) != 0 {
		t.Fatalf("A initial peers = %v, want empty", ps)
	}
	pa := newPionPeer(t, a)
	offerA := a.offer()
	if m0 := strings.Split(offerA, "m=audio")[1]; !strings.Contains(m0, "a=mid:0") || !strings.Contains(m0, "a=recvonly") {
		t.Fatalf("A offer lacks recvonly mic slot:\n%s", offerA)
	}
	pa.answer(t, offerA)

	// B joins the same room: B sees A, A sees B, both get offers carrying the
	// other's msid (stream id = userId, track id = audio-<userId>).
	b := h.dial(h.token("sB", "userB", "room1"))
	b.next("ready")
	if ps := b.peers(); len(ps) != 1 || ps[0].UserID != "userA" || ps[0].SSRC != ready.SSRC {
		t.Fatalf("B peers = %+v, want [userA/%d]", ps, ready.SSRC)
	}
	pb := newPionPeer(t, b)
	offerB := b.offer()
	if !strings.Contains(offerB, "a=msid:userA audio-userA") {
		t.Fatalf("B offer lacks A's track:\n%s", offerB)
	}
	pb.answer(t, offerB)

	if ps := a.peers(); len(ps) != 1 || ps[0].UserID != "userB" {
		t.Fatalf("A peers after B joined = %+v", ps)
	}
	reneg := a.offer()
	if !strings.Contains(reneg, "a=msid:userB audio-userB") {
		t.Fatalf("A renegotiation offer lacks B's track:\n%s", reneg)
	}
	pa.answer(t, reneg)

	// C in another room: sees nobody, and room1 hears nothing about it.
	c := h.dial(h.token("sC", "userC", "room2"))
	c.next("ready")
	if ps := c.peers(); len(ps) != 0 {
		t.Fatalf("C peers = %+v, want empty (other room)", ps)
	}
	if off := c.offer(); strings.Contains(off, "userA") || strings.Contains(off, "userB") {
		t.Fatalf("C offer leaks room1 tracks:\n%s", off)
	}
	a.quiet(300 * time.Millisecond)

	// Speaking relays to room peers only, and only on change.
	b.send("speaking", map[string]bool{"speaking": true})
	b.send("speaking", map[string]bool{"speaking": true})
	var sp struct {
		UserID   string `json:"userId"`
		Speaking bool   `json:"speaking"`
	}
	if err := json.Unmarshal(a.next("speaking"), &sp); err != nil || sp.UserID != "userB" || !sp.Speaking {
		t.Fatalf("A speaking = %+v, %v", sp, err)
	}
	c.quiet(200 * time.Millisecond)
	a.quiet(200 * time.Millisecond) // the duplicate "true" was not relayed

	// Media: B's mic RTP reaches A over real ICE/DTLS on loopback, on a
	// track whose stream id is B's userId.
	got := make(chan string, 1)
	pa.pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if _, _, err := tr.ReadRTP(); err == nil {
			select {
			case got <- tr.StreamID():
			default:
			}
		}
	})
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		seq := uint16(0)
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			seq++
			_ = pb.mic.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * 960}, Payload: []byte{0xfc, 0xff, 0xfe}})
		}
	}()
	select {
	case sid := <-got:
		if sid != "userB" {
			t.Fatalf("A got track with stream id %q, want userB", sid)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("A never received B's audio")
	}

	// A kick naming another channel is stale and ignored.
	h.srv.kick("sB", "room-elsewhere")
	b.quiet(200 * time.Millisecond)

	// Kick B: B closes 4010; A gets speaking:false for B, an empty roster
	// and a renegotiation.
	h.srv.kick("sB", "room1")
	if code := b.closeCode(); code != closeKicked {
		t.Fatalf("B close code = %d, want %d", code, closeKicked)
	}
	if err := json.Unmarshal(a.next("speaking"), &sp); err != nil || sp.UserID != "userB" || sp.Speaking {
		t.Fatalf("A speaking after kick = %+v, %v", sp, err)
	}
	if ps := a.peers(); len(ps) != 0 {
		t.Fatalf("A peers after kick = %+v", ps)
	}
	a.offer()
}

func TestVoice_CloseCodes(t *testing.T) {
	h := newHarness(t)

	bad := h.dial("")
	bad.send("identify", map[string]string{"token": "v4.public.nope"})
	if code := bad.closeCode(); code != closeBadToken {
		t.Errorf("bad token close = %d, want %d", code, closeBadToken)
	}

	wrongAud, _ := h.signer.Mint(voicetoken.Claims{SessionID: "s", UserID: "u", GuildID: "g", ChannelID: "c", MediaNodeID: "other-node"})
	if code := h.dial(wrongAud).closeCode(); code != closeBadToken {
		t.Errorf("foreign aud close = %d, want %d", code, closeBadToken)
	}

	iat := time.Now().Add(-100 * time.Second)
	expired, _ := h.signer.Mint(voicetoken.Claims{SessionID: "s", UserID: "u", GuildID: "g", ChannelID: "c", MediaNodeID: testNode, IssuedAt: iat, ExpiresAt: iat.Add(90 * time.Second)})
	if code := h.dial(expired).closeCode(); code != closeExpired {
		t.Errorf("expired close = %d, want %d", code, closeExpired)
	}

	old := identifyTimeout
	identifyTimeout = 200 * time.Millisecond
	defer func() { identifyTimeout = old }()
	if code := h.dial("").closeCode(); code != closeExpired {
		t.Errorf("identify timeout close = %d, want %d", code, closeExpired)
	}
	identifyTimeout = old

	// Replay of an accepted token is rejected; a fresh token for the same
	// session replaces the live connection with 4011.
	tok := h.token("s1", "u1", "room")
	first := h.dial(tok)
	first.next("ready")
	if code := h.dial(tok).closeCode(); code != closeBadToken {
		t.Errorf("replayed token close = %d, want %d", code, closeBadToken)
	}
	second := h.dial(h.token("s1", "u1", "room"))
	second.next("ready")
	if code := first.closeCode(); code != closeReplaced {
		t.Errorf("replaced close = %d, want %d", code, closeReplaced)
	}
	if n := h.srv.sfu.SessionCount(); n != 1 {
		t.Errorf("SessionCount after replace = %d, want 1", n)
	}
}

func TestVoice_AnswerTimeout(t *testing.T) {
	old := answerTimeout
	answerTimeout = 200 * time.Millisecond
	defer func() { answerTimeout = old }()
	h := newHarness(t)
	c := h.dial(h.token("sT", "uT", "room"))
	c.next("ready")
	c.peers()
	c.offer() // never answered
	if code := c.closeCode(); code != websocket.CloseInternalServerErr {
		t.Fatalf("close = %d, want %d", code, websocket.CloseInternalServerErr)
	}
}

func TestKickSubscriber(t *testing.T) {
	h := newHarness(t)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { runKickSubscriber(ctx, rdb, testNode, h.srv, log.New(io.Discard, "", 0)); close(done) }()
	defer func() { cancel(); <-done }()

	c := h.dial(h.token("sK", "uK", "room"))
	c.next("ready")
	deadline := time.Now().Add(5 * time.Second)
	for mr.PubSubNumSub("media:" + testNode)["media:"+testNode] == 0 {
		if time.Now().After(deadline) {
			t.Fatal("subscriber never subscribed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	rdb.Publish(ctx, "media:"+testNode, `{"op":"kick","sessionId":"sK"}`)
	if code := c.closeCode(); code != closeKicked {
		t.Fatalf("close = %d, want %d", code, closeKicked)
	}
}
