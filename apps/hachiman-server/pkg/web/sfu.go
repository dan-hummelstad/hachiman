package web

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v3"
)

const (
	opusPayloadType = 97
	opusSampleRate  = 48000
	opusFrameMs     = 20
	// Number of samples per Opus frame at 48kHz: 48000 * 20ms / 1000
	opusFrameSamples = (opusSampleRate * opusFrameMs) / 1000 // 960

	// markerGapThreshold: gap between forwarded packets that should set the
	// RTP marker bit on the next packet. RFC 3551 §4.1 — marker bit signals
	// the first packet of a talkspurt after silence so receivers can reset
	// jitter-buffer adaptation. 200ms = 10 missed 20ms frames, well beyond
	// normal jitter.
	markerGapThreshold = 200 * time.Millisecond
)

// rtpForwardState tracks per-source RTP sequence/timestamp offsets for
// stitching Mumble voice transmissions into a persistent RTP stream.
type rtpForwardState struct {
	seqOffset       uint16
	tsBase          uint32
	lastMSeq        uint64    // last Mumble sequence number seen
	frames          uint32    // total frames forwarded (for timestamp calculation)
	marker          bool      // set marker bit on first packet of new transmission
	lastForwardedAt time.Time // wall-clock of last forwarded packet (for gap detection)
}

// WebRTCClient holds per-client WebRTC state managed by the SFU.
type WebRTCClient struct {
	mu         sync.Mutex
	Session    uint32
	SSRC       uint32
	PC         *webrtc.PeerConnection
	outTracks  map[uint32]*webrtc.TrackLocalStaticRTP // sender SSRC -> output track
	rtpState   map[uint32]*rtpForwardState            // sender SSRC -> forwarding state
	talking    bool
	talkTarget uint32

	// Incoming RTP sequence-number tracking for converting the 16-bit RTP
	// SequenceNumber into a monotonic 64-bit Mumble FrameNumber. seqInit is
	// false until the first packet has been seen.
	seqInit   bool
	lastSeq   uint16
	seqCycles uint64 // number of times the 16-bit seq has wrapped

	// Callback invoked when this client sends RTP audio that should be
	// broadcast to other clients via the Mumble voice path.
	// Parameters: senderSession, opusPayload, target, frameNum.
	OnVoice func(senderSession uint32, opusPayload []byte, target uint32, frameNum uint64)
}

// SFU manages WebRTC PeerConnections and forwards audio between WebRTC
// clients and the native Mumble voice broadcast system.
type SFU struct {
	mu       sync.RWMutex
	clients  map[uint32]*WebRTCClient // session -> client
	SSRCPool *SSRCPool
	api      *webrtc.API
	logger   *log.Logger
}

// NewSFU creates a new SFU instance.
func NewSFU(logger *log.Logger) *SFU {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   opusSampleRate,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: opusPayloadType,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		logger.Printf("SFU: failed to register opus codec: %v", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(m))

	return &SFU{
		clients:  make(map[uint32]*WebRTCClient),
		SSRCPool: NewSSRCPool(),
		api:      api,
		logger:   logger,
	}
}

// AddClient creates a new WebRTC PeerConnection for the given session and
// registers it with the SFU. nativeSessions lists non-WebRTC clients whose
// audio should be receivable — output tracks are pre-created for them so
// the initial SDP offer already includes them (avoids renegotiation).
// Returns the WebRTCClient and an SDP offer that should be sent to the client.
func (s *SFU) AddClient(session uint32, nativeSessions []uint32) (*WebRTCClient, *webrtc.SessionDescription, error) {
	ssrc := s.SSRCPool.Get(session)

	pc, err := s.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		s.SSRCPool.Release(session)
		return nil, nil, fmt.Errorf("sfu: failed to create PeerConnection: %w", err)
	}

	// Add a recvonly transceiver so the initial offer includes an audio
	// slot for receiving the client's microphone audio.
	if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		pc.Close()
		s.SSRCPool.Release(session)
		return nil, nil, fmt.Errorf("sfu: failed to add recvonly transceiver: %w", err)
	}

	wc := &WebRTCClient{
		Session:   session,
		SSRC:      ssrc,
		PC:        pc,
		outTracks: make(map[uint32]*webrtc.TrackLocalStaticRTP),
		rtpState:  make(map[uint32]*rtpForwardState),
	}

	// Add output tracks for all currently connected WebRTC clients so the
	// new client can hear them immediately.
	s.mu.RLock()
	for _, existing := range s.clients {
		if existing.Session == session {
			continue
		}
		if err := wc.ensureOutputTrack(existing.SSRC); err != nil {
			s.logger.Printf("SFU: failed to add output track for ssrc %d to session %d: %v", existing.SSRC, session, err)
		}
	}
	s.mu.RUnlock()

	// Add output tracks for native (non-WebRTC) clients so the initial
	// offer includes them. This avoids dynamic track creation + renegotiation.
	for _, ns := range nativeSessions {
		nativeSSRC := s.SSRCPool.Get(ns)
		if err := wc.ensureOutputTrack(nativeSSRC); err != nil {
			s.logger.Printf("SFU: failed to add native output track for session %d (ssrc %d): %v", ns, nativeSSRC, err)
		}
	}

	// When the client sends audio, read it and call OnVoice.
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		s.logger.Printf("SFU: session %d started sending audio (ssrc=%d)", session, track.SSRC())
		go s.readIncomingRTP(wc, track)
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		s.logger.Printf("SFU: session %d connection state: %s", session, state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.RemoveClient(session)
		}
	})

	// Create an offer
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		s.SSRCPool.Release(session)
		return nil, nil, fmt.Errorf("sfu: failed to create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		s.SSRCPool.Release(session)
		return nil, nil, fmt.Errorf("sfu: failed to set local description: %w", err)
	}

	// Wait for ICE gathering to complete so we send a complete offer
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	<-gatherComplete

	s.mu.Lock()
	s.clients[session] = wc
	s.mu.Unlock()

	// Add an output track for this new client on all existing clients so
	// they can hear the new client.
	s.mu.RLock()
	for _, existing := range s.clients {
		if existing.Session == session {
			continue
		}
		existing.mu.Lock()
		if err := existing.ensureOutputTrack(ssrc); err != nil {
			s.logger.Printf("SFU: failed to add output track for new ssrc %d to session %d: %v", ssrc, existing.Session, err)
		}
		existing.mu.Unlock()
	}
	s.mu.RUnlock()

	return wc, pc.LocalDescription(), nil
}

// RemoveClient tears down the WebRTC session for the given client.
func (s *SFU) RemoveClient(session uint32) {
	s.mu.Lock()
	wc, ok := s.clients[session]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.clients, session)
	s.mu.Unlock()

	wc.mu.Lock()
	wc.PC.Close()
	wc.mu.Unlock()

	s.SSRCPool.Release(session)

	// Remove the output tracks for this client's SSRC from all remaining clients
	s.mu.RLock()
	for _, existing := range s.clients {
		existing.mu.Lock()
		delete(existing.outTracks, wc.SSRC)
		delete(existing.rtpState, wc.SSRC)
		existing.mu.Unlock()
	}
	s.mu.RUnlock()
}

// GetClient returns the WebRTCClient for the given session, if it exists.
func (s *SFU) GetClient(session uint32) *WebRTCClient {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.clients[session]
}

// HandleAnswer processes an SDP answer from a WebRTC client.
func (s *SFU) HandleAnswer(session uint32, answer webrtc.SessionDescription) error {
	wc := s.GetClient(session)
	if wc == nil {
		return fmt.Errorf("sfu: no client for session %d", session)
	}
	wc.mu.Lock()
	defer wc.mu.Unlock()
	return wc.PC.SetRemoteDescription(answer)
}

// HandleOffer processes a renegotiation SDP offer from a WebRTC client
// (e.g. after the client adds a microphone track). Returns the answer SDP.
func (s *SFU) HandleOffer(session uint32, offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	wc := s.GetClient(session)
	if wc == nil {
		return nil, fmt.Errorf("sfu: no client for session %d", session)
	}
	wc.mu.Lock()
	defer wc.mu.Unlock()

	if err := wc.PC.SetRemoteDescription(offer); err != nil {
		return nil, fmt.Errorf("sfu: failed to set remote description: %w", err)
	}

	answer, err := wc.PC.CreateAnswer(nil)
	if err != nil {
		return nil, fmt.Errorf("sfu: failed to create answer: %w", err)
	}

	if err := wc.PC.SetLocalDescription(answer); err != nil {
		return nil, fmt.Errorf("sfu: failed to set local description: %w", err)
	}

	localDesc := wc.PC.LocalDescription()
	return localDesc, nil
}

// CreateOffer creates a new SDP offer for the given session's PeerConnection.
// Used to trigger renegotiation after output tracks are added dynamically.
func (s *SFU) CreateOffer(session uint32) (*webrtc.SessionDescription, error) {
	wc := s.GetClient(session)
	if wc == nil {
		return nil, fmt.Errorf("sfu: no client for session %d", session)
	}
	wc.mu.Lock()
	defer wc.mu.Unlock()

	offer, err := wc.PC.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("sfu: failed to create offer: %w", err)
	}
	if err := wc.PC.SetLocalDescription(offer); err != nil {
		return nil, fmt.Errorf("sfu: failed to set local description: %w", err)
	}
	return wc.PC.LocalDescription(), nil
}

// AddICECandidate adds an ICE candidate from the client.
func (s *SFU) AddICECandidate(session uint32, candidate webrtc.ICECandidateInit) error {
	wc := s.GetClient(session)
	if wc == nil {
		return fmt.Errorf("sfu: no client for session %d", session)
	}
	wc.mu.Lock()
	defer wc.mu.Unlock()
	return wc.PC.AddICECandidate(candidate)
}

// ForwardToWebRTC sends an Opus frame from a Mumble sender to a specific
// WebRTC receiver. The opus payload is the raw Opus-encoded audio data.
// senderSSRC is the SSRC assigned to the sending user.
// mumbleSeq is the Mumble voice packet sequence number.
//
// The RTP marker bit is set automatically whenever the gap since the previous
// forwarded packet exceeds markerGapThreshold (or this is the first packet
// ever for this sender). This implements RFC 3551 §4.1 talkspurt-start
// semantics so receivers can reset jitter-buffer adaptation on resume.
func (s *SFU) ForwardToWebRTC(receiver *WebRTCClient, senderSSRC uint32, opusPayload []byte, mumbleSeq uint64) {
	receiver.mu.Lock()
	defer receiver.mu.Unlock()

	track, ok := receiver.outTracks[senderSSRC]
	if !ok {
		return
	}

	state, ok := receiver.rtpState[senderSSRC]
	if !ok {
		state = &rtpForwardState{}
		receiver.rtpState[senderSSRC] = state
	}

	now := time.Now()
	if state.lastForwardedAt.IsZero() || now.Sub(state.lastForwardedAt) > markerGapThreshold {
		state.marker = true
	}

	pkt := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    opusPayloadType,
			SequenceNumber: state.seqOffset,
			Timestamp:      state.tsBase + state.frames*opusFrameSamples,
			SSRC:           senderSSRC,
			Marker:         state.marker,
		},
		Payload: opusPayload,
	}

	if err := track.WriteRTP(pkt); err != nil {
		// best-effort; log and continue
		return
	}

	state.seqOffset++
	state.frames++
	state.marker = false
	state.lastMSeq = mumbleSeq
	state.lastForwardedAt = now
}

// readIncomingRTP reads RTP packets from an incoming WebRTC track and
// dispatches them to the Mumble voice broadcast system via OnVoice callback.
func (s *SFU) readIncomingRTP(wc *WebRTCClient, track *webrtc.TrackRemote) {
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			s.logger.Printf("SFU: session %d track read error: %v", wc.Session, err)
			return
		}

		wc.mu.Lock()
		target := wc.talkTarget
		cb := wc.OnVoice
		frameNum := wc.nextFrameNumberLocked(pkt.SequenceNumber)
		wc.mu.Unlock()

		if cb != nil && len(pkt.Payload) > 0 {
			cb(wc.Session, pkt.Payload, target, frameNum)
		}
	}
}

// nextFrameNumberLocked converts an incoming 16-bit RTP sequence number into a
// monotonic 64-bit Mumble FrameNumber. It implements the RFC 3711 §3.3.1
// rollover-counter (ROC) update algorithm: given the previous highest-seen
// sequence s_l (lastSeq) and current ROC (seqCycles), it computes the index
// (v, seq) of the incoming packet, treating a forward distance greater than
// 2^15 as a reorder across the previous wrap rather than a giant forward
// jump. State (lastSeq, seqCycles) is only advanced when (v, seq) is strictly
// ahead of (seqCycles, lastSeq), so reordered packets never rewind the
// monotonic counter exposed to native Mumble decoders. Must be called with
// wc.mu held.
func (wc *WebRTCClient) nextFrameNumberLocked(seq uint16) uint64 {
	if !wc.seqInit {
		wc.seqInit = true
		wc.lastSeq = seq
		wc.seqCycles = 0
		return uint64(seq)
	}

	const half = uint32(1 << 15) // 32768
	lastSeq := uint32(wc.lastSeq)
	curSeq := uint32(seq)

	var v uint64
	if lastSeq < half {
		// Forward distance from lastSeq to seq, mod 2^16.
		if (curSeq-lastSeq)&0xFFFF > half {
			// Treat as a reorder from the previous cycle.
			if wc.seqCycles == 0 {
				v = 0
			} else {
				v = wc.seqCycles - 1
			}
		} else {
			v = wc.seqCycles
		}
	} else {
		// Backward distance from seq to lastSeq, mod 2^16.
		if (lastSeq-curSeq)&0xFFFF > half {
			v = wc.seqCycles + 1
		} else {
			v = wc.seqCycles
		}
	}

	if v > wc.seqCycles || (v == wc.seqCycles && seq > wc.lastSeq) {
		wc.lastSeq = seq
		wc.seqCycles = v
	}

	return (v << 16) | uint64(seq)
}

// SetTalkingState updates the talking state for a WebRTC client.
func (wc *WebRTCClient) SetTalkingState(talking bool, target uint32) {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	wc.talking = talking
	wc.talkTarget = target
}

// ensureOutputTrack creates an output track for the given SSRC if one doesn't
// exist yet. Must be called with wc.mu held.
func (wc *WebRTCClient) ensureOutputTrack(ssrc uint32) error {
	if _, ok := wc.outTracks[ssrc]; ok {
		return nil
	}

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		fmt.Sprintf("audio-%d", ssrc),
		fmt.Sprintf("stream-%d", ssrc),
	)
	if err != nil {
		return err
	}

	if _, err := wc.PC.AddTrack(track); err != nil {
		return err
	}

	wc.outTracks[ssrc] = track
	return nil
}
