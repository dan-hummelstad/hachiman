// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Package media is the SFU behind hachiman-media: one PeerConnection per voice
// session, rooms keyed by channel id, and each member's inbound audio and
// screen share fanned out to the other members of its room only.
//
// Forwarding model: every client owns two TrackLocalStaticRTPs, its mic and
// its screen as seen by others. Both are added to each room peer's
// PeerConnection; pion fans a WriteRTP out to every binding, rewriting SSRC /
// payload type per receiver. The mic track's stream id is the sender's userId
// and the screen track's is "screen-<userId>", so receivers map remote tracks
// to users via msid. The screen track stays silent until its owner shares.
//
// Negotiation is NOT done here: the SFU mutates senders and tells the caller
// (Hooks.Renegotiate) which clients need a fresh offer. The caller serializes
// offer/answer per client.
package media

import (
	"fmt"
	"log"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
)

const (
	opusPayloadType = 111 // browsers' conventional dynamic PT for Opus
	vp8PayloadType  = 96

	// keyframeReqInterval throttles PLIs to a sharer. Without it, one viewer
	// on a lossy link makes the sharer send keyframes to the whole room.
	keyframeReqInterval = 500 * time.Millisecond
)

var opusCodec = webrtc.RTPCodecCapability{
	MimeType:    webrtc.MimeTypeOpus,
	ClockRate:   48000,
	Channels:    2,
	SDPFmtpLine: "minptime=10;useinbandfec=1",
}

// Forwarded packets keep the sharer's RTP header extensions. Do not negotiate
// sdes:mid (e.g. for simulcast) without rewriting them: Chrome routes by MID
// first and would send the sharer's mid=1 to the viewer's own upload slot.
//
// ponytail: VP8 only, every browser can encode and decode it. Add H.264/AV1
// (hardware encode at 1440p+) when a receiver-side codec match is in place.
var vp8Codec = webrtc.RTPCodecCapability{
	MimeType:  webrtc.MimeTypeVP8,
	ClockRate: 90000,
	// The default interceptors add nack, nack pli and transport-cc. FIR is
	// the other keyframe request that forwardKeyframeRequests relays.
	RTCPFeedback: []webrtc.RTCPFeedback{{Type: "ccm", Parameter: "fir"}},
}

// Config carries the network knobs pion needs on a real host.
type Config struct {
	PublicIP   string // NAT 1:1 host-candidate rewrite; "" = advertise local IPs
	UDPPortMin uint16 // 0/0 = OS-assigned ephemeral ports
	UDPPortMax uint16
	ICEServers []webrtc.ICEServer
	// IncludeLoopback advertises 127.0.0.1 candidates (tests / single-host dev).
	IncludeLoopback bool
}

// Hooks are the per-client callbacks. All are invoked outside SFU locks, may
// run on any goroutine, and must not block for long.
type Hooks struct {
	Renegotiate  func()                     // peer tracks on this PC changed
	PeersChanged func()                     // room roster changed
	ICECandidate func(*webrtc.ICECandidate) // nil = gathering complete
	Failed       func()                     // PC failed or a peer track couldn't be linked; caller tears down
	PeerLeft     func(userID string)        // a room peer left (e.g. clear its speaking state)
}

// Client is one voice session. Identity fields are immutable after Join.
type Client struct {
	SessionID, UserID, RoomID string
	SSRC                      uint32
	PC                        *webrtc.PeerConnection
	Owner                     any // caller's handle (the voice conn); lets callers skip a session-id lookup

	track   *webrtc.TrackLocalStaticRTP
	screen  *webrtc.TrackLocalStaticRTP
	senders map[string][]*webrtc.RTPSender // peer session id -> senders of peer's tracks on PC; guarded by SFU.mu
	hooks   Hooks

	// screenSSRC is the client's inbound screen RTP SSRC (0 = none yet); the
	// target of keyframe requests from viewers.
	screenSSRC atomic.Uint32
	// lastKeyframeReq is when the last PLI went to the client (unix ns).
	lastKeyframeReq atomic.Int64
}

// SFU owns clients and rooms. Safe for concurrent use.
type SFU struct {
	api    *webrtc.API
	pcCfg  webrtc.Configuration
	ssrcs  *SSRCPool
	logger *log.Logger

	mu      sync.Mutex
	clients map[string]*Client            // session id -> client
	rooms   map[string]map[string]*Client // room id -> session id -> client
}

func NewSFU(cfg Config, logger *log.Logger) (*SFU, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: opusCodec, PayloadType: opusPayloadType}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("media: register opus: %w", err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: vp8Codec, PayloadType: vp8PayloadType}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("media: register vp8: %w", err)
	}
	// Default interceptors give us RTCP sender/receiver reports (client-side
	// getStats RTT/jitter) and NACK.
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, fmt.Errorf("media: interceptors: %w", err)
	}

	se := webrtc.SettingEngine{}
	if cfg.PublicIP != "" {
		se.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}
	if cfg.UDPPortMin != 0 || cfg.UDPPortMax != 0 {
		if err := se.SetEphemeralUDPPortRange(cfg.UDPPortMin, cfg.UDPPortMax); err != nil {
			return nil, fmt.Errorf("media: udp port range: %w", err)
		}
	}
	se.SetIncludeLoopbackCandidate(cfg.IncludeLoopback)

	return &SFU{
		api:     webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se)),
		pcCfg:   webrtc.Configuration{ICEServers: cfg.ICEServers},
		ssrcs:   NewSSRCPool(),
		logger:  logger,
		clients: map[string]*Client{},
		rooms:   map[string]map[string]*Client{},
	}, nil
}

// Join creates the session's PeerConnection, allocates its SSRC and wires its
// mic and screen tracks into roomID. Existing room peers get Renegotiate + PeersChanged; the
// joiner gets neither — the caller sends its initial offer and peers
// snapshot itself.
//
// A live client with the same session id is atomically replaced and returned
// as replaced (already torn down) so the caller can close its connection with
// 4011. Doing it under one lock avoids the rejoin-vs-teardown race.
func (s *SFU) Join(sessionID, userID, roomID string, owner any, h Hooks) (c *Client, replaced *Client, err error) {
	pc, err := s.api.NewPeerConnection(s.pcCfg)
	if err != nil {
		return nil, nil, fmt.Errorf("media: new peer connection: %w", err)
	}
	// Receive slots for the client's mic and screen. Media is the offerer, so
	// without them the first offer would have no m-line for the client to send
	// on. Added first, so they are always m-lines 0 (mic) and 1 (screen), the
	// client's upload slots.
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if _, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			_ = pc.Close()
			return nil, nil, fmt.Errorf("media: add recv transceiver: %w", err)
		}
	}
	track, err := webrtc.NewTrackLocalStaticRTP(opusCodec, "audio-"+userID, userID)
	if err != nil {
		_ = pc.Close()
		return nil, nil, fmt.Errorf("media: new mic track: %w", err)
	}
	screen, err := webrtc.NewTrackLocalStaticRTP(vp8Codec, "screen-"+userID, "screen-"+userID)
	if err != nil {
		_ = pc.Close()
		return nil, nil, fmt.Errorf("media: new screen track: %w", err)
	}

	c = &Client{SessionID: sessionID, UserID: userID, RoomID: roomID, PC: pc, Owner: owner, track: track, screen: screen, senders: map[string][]*webrtc.RTPSender{}, hooks: h}

	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		out := c.track
		if remote.Kind() == webrtc.RTPCodecTypeVideo {
			out = c.screen
			c.screenSSRC.Store(uint32(remote.SSRC()))
		}
		s.forward(remote, out)
	})
	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if h.ICECandidate != nil {
			h.ICECandidate(cand)
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed && h.Failed != nil {
			h.Failed()
		}
	})

	s.mu.Lock()
	var oldPeers []*Client
	if old := s.clients[sessionID]; old != nil {
		replaced, oldPeers = old, s.removeLocked(old)
	}
	c.SSRC = s.ssrcs.Get(sessionID)
	room := s.rooms[roomID]
	if room == nil {
		room = map[string]*Client{}
		s.rooms[roomID] = room
	}
	peers := make([]*Client, 0, len(room))
	var failed []*Client
	for _, p := range room {
		if !s.link(c, p) { // joiner hears p
			failed = append(failed, c)
		}
		if !s.link(p, c) { // p hears joiner
			failed = append(failed, p)
		}
		peers = append(peers, p)
	}
	room[sessionID] = c
	s.clients[sessionID] = c
	s.mu.Unlock()

	if replaced != nil {
		_ = replaced.PC.Close()
		notifyLeft(oldPeers, replaced.UserID)
	}
	notify(peers)
	for _, f := range failed {
		// Half-wired peer: a missing track would be listed in peers but never
		// heard. Tear it down; the client rejoins via the gateway.
		if f.hooks.Failed != nil {
			f.hooks.Failed()
		}
	}
	return c, replaced, nil
}

// Remove tears c down and unlinks it from its room. It is a no-op unless c is
// still the live client for its session id, so a replaced connection's late
// cleanup can't remove its successor. Idempotent.
func (s *SFU) Remove(c *Client) {
	s.mu.Lock()
	if s.clients[c.SessionID] != c {
		s.mu.Unlock()
		return
	}
	peers := s.removeLocked(c)
	s.mu.Unlock()

	_ = c.PC.Close() // stops the forward goroutine (ReadRTP errors out)
	notifyLeft(peers, c.UserID)
}

// removeLocked unlinks c from its room and frees its SSRC, returning the
// remaining room peers. Caller holds s.mu, closes c.PC and notifies.
func (s *SFU) removeLocked(c *Client) []*Client {
	delete(s.clients, c.SessionID)
	room := s.rooms[c.RoomID]
	delete(room, c.SessionID)
	if len(room) == 0 {
		delete(s.rooms, c.RoomID)
	}
	peers := make([]*Client, 0, len(room))
	for _, p := range room {
		for _, snd := range p.senders[c.SessionID] {
			if err := p.PC.RemoveTrack(snd); err != nil {
				s.logger.Printf("media: remove track %s from %s: %v", c.SessionID, p.SessionID, err)
			}
		}
		delete(p.senders, c.SessionID)
		peers = append(peers, p)
	}
	c.senders = map[string][]*webrtc.RTPSender{}
	s.ssrcs.Release(c.SessionID)
	return peers
}

// RoomPeers returns the other live members of c's room, sorted by user id
// for stable snapshots.
func (s *SFU) RoomPeers(c *Client) []*Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clients[c.SessionID] != c {
		return nil
	}
	out := make([]*Client, 0, len(s.rooms[c.RoomID]))
	for _, p := range s.rooms[c.RoomID] {
		if p != c {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out
}

// SessionCount is the number of live sessions on this node.
func (s *SFU) SessionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.clients)
}

// link adds src's mic and screen tracks to dst's PeerConnection, each on a
// fresh sendonly transceiver. Not AddTrack: pion would reuse the sender-less
// recvonly upload transceivers (m-lines 0 and 1), and the client relies on
// those being its exclusive upload slots. Caller holds s.mu.
//
// Returns false if a track couldn't be added.
//
// ponytail: removed peers leave stopped (inactive) m-lines behind, so SDP
// grows with join/leave churn over a long session. Recycle stopped
// transceivers via RTPSender.ReplaceTrack if rooms get large or long-lived.
// ponytail: every peer receives every share at the sharer's quality; add a
// per-viewer "watch" op (and simulcast) when room bandwidth matters.
func (s *SFU) link(dst, src *Client) bool {
	for _, track := range []*webrtc.TrackLocalStaticRTP{src.track, src.screen} {
		t, err := dst.PC.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			s.logger.Printf("media: add track %s -> %s: %v", src.SessionID, dst.SessionID, err)
			return false
		}
		snd := t.Sender()
		dst.senders[src.SessionID] = append(dst.senders[src.SessionID], snd)
		// A viewer that joins mid-share asks for its first keyframe here.
		go readRTCP(snd, src, track == src.screen)
	}
	return true
}

// readRTCP reads RTCP off snd until the sender is removed or the PC closes.
// pion needs RTCP read off every sender for the interceptors (NACK, reports)
// to run. On the screen sender, a viewer's PLI/FIR for this stream becomes a
// PLI to src. srtp hands a compound packet to every SSRC it names, so the
// SSRC check keeps another stream's request out.
func readRTCP(snd *webrtc.RTPSender, src *Client, screen bool) {
	var ssrc uint32
	if screen {
		ssrc = uint32(snd.GetParameters().Encodings[0].SSRC)
	}
	for {
		pkts, _, err := snd.ReadRTCP()
		if err != nil {
			return
		}
		for _, p := range pkts {
			switch r := p.(type) {
			case *rtcp.PictureLossIndication:
				if screen && r.MediaSSRC == ssrc {
					src.requestKeyframe()
				}
			case *rtcp.FullIntraRequest: // FIR names its stream per entry
				for _, e := range r.FIR {
					if screen && e.SSRC == ssrc {
						src.requestKeyframe()
					}
				}
			}
		}
	}
}

// requestKeyframe asks the client to send a fresh keyframe on its screen
// upload, at most once per keyframeReqInterval. A no-op until the client has
// shared once.
func (c *Client) requestKeyframe() {
	ssrc := c.screenSSRC.Load()
	if ssrc == 0 {
		return
	}
	now, last := time.Now().UnixNano(), c.lastKeyframeReq.Load()
	if now-last < int64(keyframeReqInterval) || !c.lastKeyframeReq.CompareAndSwap(last, now) {
		return
	}
	_ = c.PC.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
}

// forward pumps inbound RTP into the client's matching output track, which
// pion fans out to every room peer's PeerConnection. Runs on pion's OnTrack
// goroutine until the PC closes.
func (s *SFU) forward(remote *webrtc.TrackRemote, out *webrtc.TrackLocalStaticRTP) {
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			return
		}
		// ErrClosedPipe just means no peer bindings yet; nothing to do.
		_ = out.WriteRTP(pkt)
	}
}

func notifyLeft(peers []*Client, userID string) {
	for _, p := range peers {
		if p.hooks.PeerLeft != nil {
			p.hooks.PeerLeft(userID)
		}
	}
	notify(peers)
}

func notify(peers []*Client) {
	// Roster before offer, so the client knows who a new msid belongs to.
	for _, p := range peers {
		if p.hooks.PeersChanged != nil {
			p.hooks.PeersChanged()
		}
		if p.hooks.Renegotiate != nil {
			p.hooks.Renegotiate()
		}
	}
}
