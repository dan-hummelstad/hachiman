// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"

	"hachiman/server/pkg/media"
	"hachiman/server/pkg/voicetoken"
)

// Close codes, contract §8.
const (
	closeBadToken = 4004
	closeExpired  = 4009 // token expired or identify timeout
	closeKicked   = 4010
	closeReplaced = 4011
)

const (
	writeTimeout = 10 * time.Second
	sendQueueLen = 256
	pingInterval = 20 * time.Second
	readTimeout  = 60 * time.Second // extended by every pong
	speakingRate = 10               // max speaking relays per second per conn; excess dropped

	// defaultReadLimit fits a Welcome or a ratchet tree of a large call
	// (MEDIA_WS_READ_LIMIT overrides it).
	defaultReadLimit = 1 << 20
)

// vars so tests can shorten them
var (
	identifyTimeout = 10 * time.Second
	answerTimeout   = 15 * time.Second // offer sent, no answer → 1011
	connectTimeout  = 30 * time.Second // joined, PC never connected → 1011 (ghost PCs stuck in "new")
)

type frame struct {
	Op string          `json:"op"`
	D  json.RawMessage `json:"d,omitempty"`
}

type peerInfo struct {
	UserID string `json:"userId"`
	SSRC   uint32 `json:"ssrc"`
}

// voiceServer serves /voice. Auth is the voice token, so any Origin is fine.
type voiceServer struct {
	sfu      *media.SFU
	verifier *voicetoken.Verifier
	logger   *log.Logger
	upgrader websocket.Upgrader
	e2ee     *e2eeState

	// readLimit is the largest client frame; set before serving.
	readLimit int64

	mu    sync.Mutex
	conns map[string]*voiceConn // session id -> live conn

	// shuttingDown skips roster/renegotiation work while closeAll tears every
	// session down (no point offering to conns that are about to close).
	shuttingDown atomic.Bool

	// onEnd runs when a joined call closes for any reason but a kick, a
	// replace (the gateway caused those) or shutdown. main.go publishes
	// VOICE_DISCONNECTED.
	onEnd func(*voicetoken.Claims)
}

func newVoiceServer(sfu *media.SFU, v *voicetoken.Verifier, logger *log.Logger) *voiceServer {
	s := &voiceServer{
		sfu: sfu, verifier: v, logger: logger,
		upgrader:  websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		readLimit: defaultReadLimit,
		conns:     map[string]*voiceConn{},
	}
	s.e2ee = newE2EEState(s)
	return s
}

func (s *voiceServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the HTTP error
	}
	ws.SetReadLimit(s.readLimit)
	c := &voiceConn{srv: s, ws: ws, out: make(chan []byte, sendQueueLen), done: make(chan struct{})}
	go c.writeLoop()
	c.readLoop()
}

func (s *voiceServer) lookup(sessionID string) *voiceConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns[sessionID]
}

// kick closes a session on gateway request (Redis media:{nodeId}). A
// non-empty channelID must match the session's room, so a kick for the
// user's previous channel can't hit a session that already moved on.
func (s *voiceServer) kick(sessionID, channelID string) {
	if c := s.lookup(sessionID); c != nil && (channelID == "" || c.claims.ChannelID == channelID) {
		c.close(closeKicked, "kicked")
	}
}

func (s *voiceServer) closeAll(code int, reason string) {
	s.shuttingDown.Store(true)
	s.mu.Lock()
	all := make([]*voiceConn, 0, len(s.conns))
	for _, c := range s.conns {
		all = append(all, c)
	}
	s.mu.Unlock()
	for _, c := range all {
		c.close(code, reason)
	}
}

// voiceConn is one client socket. Goroutines: readLoop (the HTTP handler
// goroutine) handles client frames in order; writeLoop is the sole data
// writer; SFU hooks run on other conns' goroutines / pion's.
type voiceConn struct {
	srv       *voiceServer
	ws        *websocket.Conn
	out       chan []byte
	done      chan struct{}
	closeOnce sync.Once

	claims *voicetoken.Claims

	// peersMu orders roster snapshots: compute + enqueue happen under it, so
	// the last "peers" frame the client sees always reflects the latest state.
	// It also publishes client to hooks that fire before Join returns.
	peersMu sync.Mutex
	client  *media.Client

	// Negotiation state. Media is always the offerer; at most one offer is
	// outstanding. Changes that arrive mid-negotiation set pending and are
	// folded into one follow-up offer after the answer lands, so we never
	// call CreateOffer in have-local-offer (no glare, no lost tracks).
	negMu       sync.Mutex
	negotiating bool
	pending     bool
	answerTimer *time.Timer

	// Speaking relay: only on change, rate-limited (reader goroutine only).
	speaking    bool
	speakWindow time.Time
	speakCount  int

	// sigMu spans SetLocalDescription + enqueueing the offer, and the ICE
	// hook takes it too, so server candidates never overtake their offer.
	sigMu sync.Mutex
}

func (c *voiceConn) send(op string, d any) {
	b, err := json.Marshal(struct {
		Op string `json:"op"`
		D  any    `json:"d"`
	}{op, d})
	if err != nil {
		c.srv.logger.Printf("marshal %s: %v", op, err)
		return
	}
	select {
	case c.out <- b:
	case <-c.done:
	default:
		// A client that can't drain sendQueueLen frames is wedged; drop it rather than
		// block SFU hooks running on other sessions' goroutines.
		go c.close(websocket.ClosePolicyViolation, "send queue full")
	}
}

func (c *voiceConn) writeLoop() {
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-ping.C:
			if err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
				c.close(websocket.CloseAbnormalClosure, "")
				return
			}
		case b := <-c.out:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.ws.WriteMessage(websocket.TextMessage, b); err != nil {
				c.close(websocket.CloseAbnormalClosure, "")
				return
			}
		case <-c.done:
			return
		}
	}
}

// close tears the session down exactly once: close frame, socket, SFU
// client, and the session map entry (only if it still points at us, so a
// replaced conn can't evict its successor).
func (c *voiceConn) close(code int, reason string) {
	c.closeOnce.Do(func() {
		close(c.done)
		c.negMu.Lock()
		if c.answerTimer != nil {
			c.answerTimer.Stop()
		}
		c.negMu.Unlock()
		_ = c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
		_ = c.ws.Close()
		c.srv.e2ee.leave(c) // before SFU.Remove: peers get the roster before the offer
		if c.claims != nil {
			c.srv.mu.Lock()
			if c.srv.conns[c.claims.SessionID] == c {
				delete(c.srv.conns, c.claims.SessionID)
			}
			c.srv.mu.Unlock()
		}
		c.peersMu.Lock()
		cl := c.client
		c.peersMu.Unlock()
		if cl != nil {
			c.srv.sfu.Remove(cl)
			// Shutdown: clients get 1001 and leave themselves.
			if c.srv.onEnd != nil && code != closeKicked && code != closeReplaced && !c.srv.shuttingDown.Load() {
				c.srv.onEnd(c.claims)
			}
		}
	})
}

func (c *voiceConn) readLoop() {
	defer c.close(websocket.CloseNormalClosure, "")

	if !c.identify() {
		return
	}
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		var f frame
		if err := json.Unmarshal(data, &f); err != nil {
			continue
		}
		if strings.HasPrefix(f.Op, "e2ee_") {
			c.srv.e2ee.handle(c, f.Op, f.D)
			continue
		}
		switch f.Op {
		case "answer":
			var d struct {
				SDP string `json:"sdp"`
			}
			if json.Unmarshal(f.D, &d) == nil {
				c.onAnswer(d.SDP)
			}
		case "candidate":
			var d struct {
				Candidate *webrtc.ICECandidateInit `json:"candidate"`
			}
			// null = client finished gathering; pion needs no signal for it.
			if json.Unmarshal(f.D, &d) == nil && d.Candidate != nil && d.Candidate.Candidate != "" {
				if err := c.client.PC.AddICECandidate(*d.Candidate); err != nil {
					c.srv.logger.Printf("session %s: add candidate: %v", c.claims.SessionID, err)
				}
			}
		case "speaking":
			var d struct {
				Speaking bool `json:"speaking"`
			}
			if json.Unmarshal(f.D, &d) == nil {
				c.relaySpeaking(d.Speaking)
			}
		}
	}
}

// identify runs the §8 handshake: identify within 10 s → E2EE check → verify
// → replace any live conn with the same session → join the SFU → ready +
// peers + e2ee_roster + offer.
func (c *voiceConn) identify() bool {
	_ = c.ws.SetReadDeadline(time.Now().Add(identifyTimeout))
	var f frame
	if err := c.ws.ReadJSON(&f); err != nil {
		var ne interface{ Timeout() bool }
		if errors.As(err, &ne) && ne.Timeout() {
			c.close(closeExpired, "identify timeout")
		}
		return false
	}
	// Keepalive: writeLoop pings; each pong (or frame, see readLoop) pushes
	// the deadline so a silently dead socket is reaped within readTimeout.
	_ = c.ws.SetReadDeadline(time.Now().Add(readTimeout))
	c.ws.SetPongHandler(func(string) error { return c.ws.SetReadDeadline(time.Now().Add(readTimeout)) })
	var d struct {
		Token string `json:"token"`
		E2EE  *struct {
			Version    int    `json:"version"`
			KeyPackage string `json:"keyPackage"`
		} `json:"e2ee"`
	}
	if f.Op != "identify" || json.Unmarshal(f.D, &d) != nil {
		c.close(closeBadToken, "expected identify")
		return false
	}
	// Checked before the token, so a refused client does not burn its jti.
	if d.E2EE == nil || d.E2EE.Version != 1 {
		c.close(closeE2EERequired, "e2ee required")
		return false
	}
	if _, err := decodeB64url(d.E2EE.KeyPackage); err != nil {
		c.close(closeE2EEProtocol, "bad key package")
		return false
	}
	claims, err := c.srv.verifier.Verify(d.Token)
	if errors.Is(err, voicetoken.ErrExpired) {
		c.close(closeExpired, "token expired")
		return false
	}
	if err != nil {
		c.srv.logger.Printf("identify: %v", err)
		c.close(closeBadToken, "authentication failed")
		return false
	}
	if claims.DeviceID == "" {
		// The roster identity of an E2EE participant is its device (§7).
		c.close(closeBadToken, "token has no device")
		return false
	}

	c.srv.mu.Lock()
	old := c.srv.conns[claims.SessionID]
	c.srv.conns[claims.SessionID] = c
	c.claims = claims
	c.srv.mu.Unlock()
	if old != nil {
		old.close(closeReplaced, "replaced")
	}

	// Mark the initial negotiation in flight before joining so a peer
	// change racing the join becomes a follow-up offer, not a second one.
	c.negMu.Lock()
	c.negotiating = true
	c.negMu.Unlock()

	// Join under srv.mu, and only while we still own the session slot: a
	// same-session conn that identified after us has taken the map entry,
	// and we must not join afterwards and evict it.
	// ponytail: srv.mu is held across PC creation + peer renegotiation
	// (milliseconds); split it if join rate ever makes that contended.
	c.srv.mu.Lock()
	if c.srv.conns[claims.SessionID] != c {
		c.srv.mu.Unlock()
		c.close(closeReplaced, "replaced")
		return false
	}
	cl, replaced, err := c.srv.sfu.Join(claims.SessionID, claims.UserID, claims.ChannelID, c, media.Hooks{
		Renegotiate:  c.renegotiate,
		PeersChanged: c.sendPeers,
		ICECandidate: c.onLocalCandidate,
		Failed:       func() { go c.close(websocket.CloseInternalServerErr, "media failed") },
		PeerLeft:     c.peerLeft,
	})
	c.srv.mu.Unlock()
	if replaced != nil {
		// A predecessor whose close hadn't reached SFU.Remove yet; Join
		// already evicted it, closing its socket is idempotent.
		replaced.Owner.(*voiceConn).close(closeReplaced, "replaced")
	}
	if err != nil {
		c.srv.logger.Printf("session %s: join: %v", claims.SessionID, err)
		c.close(websocket.CloseInternalServerErr, "join failed")
		return false
	}
	c.peersMu.Lock()
	c.client = cl
	c.peersMu.Unlock()
	select { // closed (kick/replace) while joining: close already ran without the client
	case <-c.done:
		c.srv.sfu.Remove(cl)
		return false
	default:
	}

	time.AfterFunc(connectTimeout, func() {
		if st := cl.PC.ConnectionState(); st != webrtc.PeerConnectionStateConnected && st != webrtc.PeerConnectionStateDisconnected {
			c.close(websocket.CloseInternalServerErr, "connect timeout")
		}
	})
	c.srv.logger.Printf("session %s joined room %s (user %s, ssrc %d)", claims.SessionID, claims.ChannelID, claims.UserID, cl.SSRC)
	c.send("ready", map[string]any{"sessionId": claims.SessionID, "ssrc": cl.SSRC})
	c.sendPeers()
	c.srv.e2ee.join(c, d.E2EE.KeyPackage)
	c.sendOffer()
	return true
}

func (c *voiceConn) sendPeers() {
	if c.srv.shuttingDown.Load() {
		return
	}
	c.peersMu.Lock()
	defer c.peersMu.Unlock()
	if c.client == nil {
		return // pre-join hook; identify sends the first snapshot itself
	}
	peers := []peerInfo{}
	for _, p := range c.srv.sfu.RoomPeers(c.client) {
		peers = append(peers, peerInfo{UserID: p.UserID, SSRC: p.SSRC})
	}
	c.send("peers", map[string]any{"peers": peers})
}

func (c *voiceConn) relaySpeaking(speaking bool) {
	if speaking == c.speaking {
		return
	}
	if now := time.Now(); now.Sub(c.speakWindow) >= time.Second {
		c.speakWindow, c.speakCount = now, 0
	}
	if c.speakCount >= speakingRate {
		return // ponytail: a dropped edge isn't resent; fine for honest clients sending only on change
	}
	c.speakCount++
	c.speaking = speaking
	msg := map[string]any{"userId": c.claims.UserID, "speaking": speaking}
	for _, p := range c.srv.sfu.RoomPeers(c.client) {
		p.Owner.(*voiceConn).send("speaking", msg)
	}
}

// peerLeft clears a departed peer's speaking indicator on this client.
func (c *voiceConn) peerLeft(userID string) {
	if !c.srv.shuttingDown.Load() {
		c.send("speaking", map[string]any{"userId": userID, "speaking": false})
	}
}

// renegotiate is the SFU hook: offer now if idle, else fold into a
// follow-up offer once the outstanding answer lands.
func (c *voiceConn) renegotiate() {
	if c.srv.shuttingDown.Load() {
		return
	}
	c.negMu.Lock()
	if c.negotiating {
		c.pending = true
		c.negMu.Unlock()
		return
	}
	c.negotiating = true
	c.negMu.Unlock()
	c.sendOffer()
}

func (c *voiceConn) sendOffer() {
	c.sigMu.Lock()
	defer c.sigMu.Unlock()
	pc := c.client.PC
	offer, err := pc.CreateOffer(nil)
	if err == nil {
		err = pc.SetLocalDescription(offer)
	}
	if err != nil {
		c.srv.logger.Printf("session %s: offer: %v", c.claims.SessionID, err)
		go c.close(websocket.CloseInternalServerErr, "negotiation failed")
		return
	}
	c.negMu.Lock()
	if c.answerTimer != nil {
		c.answerTimer.Stop()
	}
	c.answerTimer = time.AfterFunc(answerTimeout, func() { c.close(websocket.CloseInternalServerErr, "answer timeout") })
	c.negMu.Unlock()
	c.send("offer", map[string]string{"sdp": pc.LocalDescription().SDP})
}

func (c *voiceConn) onAnswer(sdp string) {
	c.negMu.Lock()
	outstanding := c.negotiating
	if outstanding && c.answerTimer != nil {
		c.answerTimer.Stop()
	}
	c.negMu.Unlock()
	if !outstanding {
		return // stray answer; nothing to apply it to
	}
	if err := c.client.PC.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		c.srv.logger.Printf("session %s: set answer: %v", c.claims.SessionID, err)
		c.close(websocket.CloseInternalServerErr, "bad answer")
		return
	}
	c.negMu.Lock()
	again := c.pending
	c.pending = false
	c.negotiating = again
	c.negMu.Unlock()
	if again {
		c.sendOffer()
	}
}

func (c *voiceConn) onLocalCandidate(cand *webrtc.ICECandidate) {
	c.sigMu.Lock()
	defer c.sigMu.Unlock()
	if cand == nil {
		c.send("candidate", map[string]any{"candidate": nil})
		return
	}
	c.send("candidate", map[string]any{"candidate": cand.ToJSON()})
}
