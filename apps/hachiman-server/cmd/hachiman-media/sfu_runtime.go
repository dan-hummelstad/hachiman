// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v3"

	"mumble.info/grumble/pkg/media"
	"mumble.info/grumble/pkg/mediaproto"
)

// Phase 1 final pass: the SFU now runs in hachiman-media, driven by the
// MediaControl sidechannel. sfuRuntime owns:
//
//   - the underlying pkg/media.SFU instance,
//   - a session map (session_id → sessionState) tracking which client a media
//     SSRC belongs to and what room it's in,
//   - a room map (room_id → set of session ids) used both for OpenRoom/Close-
//     Room bookkeeping AND for fan-out when forwarding inbound RTP frames to
//     other members.
//
// Dispatch is driven by the sidechannel client (sidechannel_client.go): each
// inbound envelope is handed to HandleEnvelope which routes by payload type.
// Outbound envelopes (the SDP offer from a fresh OpenSession, ICE candidates
// from the gatherer, SessionEstablished / SessionEnded notifications) go back
// out via the sender callback wired in at construction time.
//
// Concurrency: the maps are guarded by `mu`. The SFU's own callbacks (OnVoice,
// OnICECandidate) fire from pion's internal goroutines and call back into the
// runtime — those paths take the RLock briefly to find peers, then release
// before calling into the SFU's hot-path ForwardToWebRTC (which has its own
// per-receiver lock).

// envelopeSender pushes an outbound envelope onto the active sidechannel
// stream. The implementation in sidechannel_client.go wraps stream.Send with
// the stream's mutex; nil sender = headless mode (tests).
type envelopeSender func(*mediaproto.Envelope) error

// sessionState tracks a single SFU session.
type sessionState struct {
	wc     *media.WebRTCClient
	roomID string
	ssrc   uint32

	// sessionUint is the uint32 form of the session_id suffix (after the
	// `<vServerID>:` prefix) — equals the Mumble session, used as the SFU
	// session key. Cached here so handlers don't re-parse on the hot path.
	sessionUint uint32
}

// sfuRuntime is the media-binary's stateful coordinator.
type sfuRuntime struct {
	logger *log.Logger
	sfu    *media.SFU

	mu       sync.RWMutex
	sessions map[string]*sessionState       // session_id → state
	rooms    map[string]map[string]struct{} // room_id → set of session ids

	// send pushes envelopes back to control via the current sidechannel
	// stream. Read under mu; set/cleared by the sidechannel client around
	// connect/disconnect. nil between reconnects — outbound work is dropped
	// in that window (media-→control envelopes are best-effort on a
	// partition by design, see MEDIA-PLANE-MIGRATION.md SLOs).
	send envelopeSender
}

func newSFURuntime(logger *log.Logger, region string) *sfuRuntime {
	r := &sfuRuntime{
		logger:   logger,
		sfu:      media.NewSFU(logger, region),
		sessions: make(map[string]*sessionState),
		rooms:    make(map[string]map[string]struct{}),
	}
	// MEDIUM #1: when pion's OnConnectionStateChange fires Failed/Closed the
	// SFU.RemoveClient runs but the runtime's session/room maps still hold a
	// dangling sessionState. Wire SFU.OnClientRemoved to the runtime's
	// CloseSession path so the cleanup is unified.
	r.sfu.SetOnClientRemoved(func(session uint32) {
		// Find any session_id that maps to this uint and tear it down. There
		// shouldn't be more than one — sessions are 1:1 with sessionUint —
		// but loop defensively.
		r.mu.RLock()
		var matches []string
		for id, st := range r.sessions {
			if st.sessionUint == session {
				matches = append(matches, id)
			}
		}
		r.mu.RUnlock()
		for _, id := range matches {
			r.handleCloseSession(id, mediaproto.SessionEnded_REASON_ICE_FAILED)
		}
	})
	return r
}

// SetSender wires (or clears) the outbound envelope sink. Called by the
// sidechannel client at stream connect (with the actual send) and at stream
// disconnect (with nil) so the runtime knows the wire is live.
func (r *sfuRuntime) SetSender(s envelopeSender) {
	r.mu.Lock()
	r.send = s
	r.mu.Unlock()
}

// stats returns live counters for heartbeat reporting (follow-up #9 partial).
// CPU% / mem% are still zero — they need gopsutil and aren't worth the dep
// for this pass.
func (r *sfuRuntime) stats() (activeSessions, activeRooms uint32) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return uint32(len(r.sessions)), uint32(len(r.rooms))
}

// HandleEnvelope routes an inbound envelope from control. Payload types this
// runtime does NOT act on (Ack, StreamError, OpenRoom-without-session-impl)
// are quietly accepted; future passes can extend the switch.
func (r *sfuRuntime) HandleEnvelope(env *mediaproto.Envelope) {
	if env == nil {
		return
	}
	switch p := env.GetPayload().(type) {
	case *mediaproto.Envelope_OpenRoom:
		r.handleOpenRoom(p.OpenRoom)
	case *mediaproto.Envelope_CloseRoom:
		r.handleCloseRoom(p.CloseRoom)
	case *mediaproto.Envelope_OpenSession:
		r.handleOpenSession(p.OpenSession)
	case *mediaproto.Envelope_CloseSession:
		r.handleCloseSession(p.CloseSession.GetSessionId(),
			mediaproto.SessionEnded_REASON_CLIENT_DISCONNECT)
	case *mediaproto.Envelope_KickSession:
		r.handleCloseSession(p.KickSession.GetSessionId(),
			mediaproto.SessionEnded_REASON_KICK)
	case *mediaproto.Envelope_SdpSignal:
		r.handleSdpSignal(p.SdpSignal)
	case *mediaproto.Envelope_IceCandidateSignal:
		r.handleIceCandidateSignal(p.IceCandidateSignal)
	case *mediaproto.Envelope_SessionMove:
		r.handleSessionMove(p.SessionMove)
	}
}

// handleOpenRoom records a room id so subsequent OpenSession calls into it
// can validate the room exists. Idempotent — re-issuing OpenRoom for an
// existing room is a safe no-op, matching the at-least-once delivery
// semantics on the sidechannel.
func (r *sfuRuntime) handleOpenRoom(p *mediaproto.OpenRoom) {
	if p == nil || p.GetRoomId() == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.rooms[p.GetRoomId()]; !ok {
		r.rooms[p.GetRoomId()] = make(map[string]struct{})
		r.logger.Printf("[sfu-runtime] room %s opened (channel=%d region=%q)",
			p.GetRoomId(), p.GetChannelId(), p.GetHomeRegion())
	}
}

// handleCloseRoom tears down all sessions in the room and forgets it.
func (r *sfuRuntime) handleCloseRoom(p *mediaproto.CloseRoom) {
	if p == nil || p.GetRoomId() == "" {
		return
	}
	r.mu.Lock()
	roomID := p.GetRoomId()
	members, ok := r.rooms[roomID]
	if !ok {
		r.mu.Unlock()
		return
	}
	// Copy the member set out so we can iterate after dropping the lock —
	// teardownSessionLocked re-acquires and we don't want a recursive lock.
	sessionIDs := make([]string, 0, len(members))
	for id := range members {
		sessionIDs = append(sessionIDs, id)
	}
	delete(r.rooms, roomID)
	r.mu.Unlock()
	for _, sid := range sessionIDs {
		r.handleCloseSession(sid, mediaproto.SessionEnded_REASON_NODE_SHUTDOWN)
	}
	r.logger.Printf("[sfu-runtime] room %s closed; tore down %d sessions", roomID, len(sessionIDs))
}

// sessionUintFromID strips the `<vServerID>:` prefix (CRITICAL #5) before
// parsing the suffix into a uint32. If no prefix is present the entire
// string is parsed (back-compat with single-vServer dev setups). Returns
// (0, false) on malformed input.
func sessionUintFromID(sessionID string) (uint32, bool) {
	suffix := sessionID
	if idx := strings.IndexByte(sessionID, ':'); idx >= 0 {
		suffix = sessionID[idx+1:]
	}
	v, err := strconv.ParseUint(suffix, 10, 32)
	if err != nil {
		return 0, false
	}
	return uint32(v), true
}

// handleOpenSession creates a new pion PeerConnection via the SFU, wires the
// OnVoice / OnICECandidate callbacks for fan-out, and sends the generated
// SDP offer back to control via SdpSignal{type:"offer"}. Also emits
// SessionEstablished.
//
// CRITICAL #3: after the new session lands, every OTHER session in the same
// room needs a fresh SDP offer — pion has the new output track in its send
// list but never advertises it until SetLocalDescription runs again.
//
// HIGH #5: a duplicate OpenSession for an existing session_id tears the old
// peer down first so the previous pion PeerConnection doesn't leak.
func (r *sfuRuntime) handleOpenSession(p *mediaproto.OpenSession) {
	if p == nil || p.GetSessionId() == "" {
		return
	}
	sessionUint, ok := sessionUintFromID(p.GetSessionId())
	if !ok {
		r.logger.Printf("[sfu-runtime] OpenSession: non-numeric session_id %q", p.GetSessionId())
		r.sendStreamError(p.GetSessionId(), mediaproto.StreamError_CODE_MALFORMED, "non-numeric session_id")
		return
	}

	// HIGH #5: if we already have a session under this id, close it first.
	// Idempotent at-least-once delivery shouldn't leak a PeerConnection if
	// control resends OpenSession after a partition.
	r.mu.RLock()
	_, dup := r.sessions[p.GetSessionId()]
	r.mu.RUnlock()
	if dup {
		r.logger.Printf("[sfu-runtime] OpenSession: duplicate session_id %q; tearing down previous peer first",
			p.GetSessionId())
		r.handleCloseSession(p.GetSessionId(), mediaproto.SessionEnded_REASON_UNSPECIFIED)
	}

	// Defensively unwind if the SFU layer fails — the next attempt should
	// see a clean slate.
	wc, offer, err := r.sfu.AddClient(sessionUint, nil)
	if err != nil {
		r.logger.Printf("[sfu-runtime] AddClient(%s): %v", p.GetSessionId(), err)
		r.sendStreamError(p.GetSessionId(), mediaproto.StreamError_CODE_INTERNAL, err.Error())
		return
	}

	// Wire fan-out. The previous control-side OnVoice forwarded across
	// channel members; the room map is the equivalent here. We capture
	// the room id from the envelope so the closure doesn't have to look
	// it up on every frame.
	//
	// CRITICAL: take the WebRTCClient lock before assigning the callbacks.
	// pion's gatherer can fire OnICECandidate from a separate goroutine,
	// and the SFU's wrapper reads the OnICECandidate field under that same
	// lock. Even though gathering completes before AddClient returns, the
	// race detector flags the unsynchronised assignment because the prior
	// reads from pion's callbacks happened on another goroutine without
	// any happens-before edge between them and our write here. The mutex
	// supplies that edge.
	roomID := p.GetRoomId()
	sessionIDLocal := p.GetSessionId()
	wc.SetCallbacks(
		func(senderSession uint32, opusPayload []byte, _ uint32, frameNum uint64) {
			r.fanOutVoice(roomID, sessionIDLocal, wc, opusPayload, frameNum)
		},
		func(c *webrtc.ICECandidate) {
			r.forwardServerICECandidate(sessionIDLocal, c)
		},
	)

	r.mu.Lock()
	r.sessions[sessionIDLocal] = &sessionState{
		wc:          wc,
		roomID:      roomID,
		ssrc:        wc.SSRC,
		sessionUint: sessionUint,
	}
	// Ensure the room exists even if OpenRoom never landed (at-least-once
	// delivery doesn't guarantee ordering — defensively create).
	if _, ok := r.rooms[roomID]; !ok {
		r.rooms[roomID] = make(map[string]struct{})
	}
	r.rooms[roomID][sessionIDLocal] = struct{}{}
	// CRITICAL #3: snapshot the room's OTHER session ids so we can
	// renegotiate them outside the lock. Each existing peer has a new
	// output track for the joiner that pion added during AddClient, but
	// SetLocalDescription hasn't re-run on those peers yet — their SDP
	// doesn't advertise the track until we ask for a fresh offer.
	peerIDsForReneg := make([]string, 0, len(r.rooms[roomID]))
	for sid := range r.rooms[roomID] {
		if sid == sessionIDLocal {
			continue
		}
		peerIDsForReneg = append(peerIDsForReneg, sid)
	}
	send := r.send
	r.mu.Unlock()

	// Send the SDP offer back to control as SdpSignal{type:"offer"}.
	if send != nil {
		offerEnv := &mediaproto.Envelope{
			IdempotencyKey: uuid.NewString(),
			Payload: &mediaproto.Envelope_SdpSignal{
				SdpSignal: &mediaproto.SdpSignal{
					SessionId: sessionIDLocal,
					SdpType:   "offer",
					Sdp:       offer.SDP,
				},
			},
		}
		if err := send(offerEnv); err != nil {
			r.logger.Printf("[sfu-runtime] send SDP offer for session %s: %v", sessionIDLocal, err)
		}

		estEnv := &mediaproto.Envelope{
			IdempotencyKey: uuid.NewString(),
			Payload: &mediaproto.Envelope_SessionEstablished{
				SessionEstablished: &mediaproto.SessionEstablished{
					SessionId: sessionIDLocal,
					RoomId:    roomID,
					// CRITICAL #1: echo the SSRC media actually assigned
					// (equals sessionUint under the phase-1 identity
					// contract); control re-records this on the client and
					// rebroadcasts UserState.
					Ssrc: wc.SSRC,
				},
			},
		}
		if err := send(estEnv); err != nil {
			r.logger.Printf("[sfu-runtime] send SessionEstablished for session %s: %v", sessionIDLocal, err)
		}
	}

	// CRITICAL #3: now renegotiate the existing peers so their SDP
	// advertises the new joiner's output track. SFU.CreateOffer serializes
	// on the per-WebRTCClient mutex so pion's renegotiation state machine
	// isn't tripped by parallel SetLocalDescription calls.
	for _, peerID := range peerIDsForReneg {
		peerUint, ok := sessionUintFromID(peerID)
		if !ok {
			continue
		}
		peerOffer, err := r.sfu.CreateOffer(peerUint)
		if err != nil {
			r.logger.Printf("[sfu-runtime] renegotiation CreateOffer(%s) for joiner %s failed: %v",
				peerID, sessionIDLocal, err)
			continue
		}
		if send != nil {
			renegEnv := &mediaproto.Envelope{
				IdempotencyKey: uuid.NewString(),
				Payload: &mediaproto.Envelope_SdpSignal{
					SdpSignal: &mediaproto.SdpSignal{
						SessionId: peerID,
						SdpType:   "offer",
						Sdp:       peerOffer.SDP,
					},
				},
			}
			if err := send(renegEnv); err != nil {
				r.logger.Printf("[sfu-runtime] send renegotiation SDP for session %s: %v", peerID, err)
			}
		}
	}

	r.logger.Printf("[sfu-runtime] session %s opened (room=%s ssrc=%d peers_renegotiated=%d)",
		sessionIDLocal, roomID, wc.SSRC, len(peerIDsForReneg))
}

// handleCloseSession removes the session from the SFU + maps and sends a
// SessionEnded back to control with the given reason. Idempotent.
func (r *sfuRuntime) handleCloseSession(sessionID string, reason mediaproto.SessionEnded_Reason) {
	if sessionID == "" {
		return
	}
	sessionUint, ok := sessionUintFromID(sessionID)
	if !ok {
		r.logger.Printf("[sfu-runtime] CloseSession: non-numeric session_id %q", sessionID)
		return
	}

	r.mu.Lock()
	state, ok := r.sessions[sessionID]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.sessions, sessionID)
	if members, hasRoom := r.rooms[state.roomID]; hasRoom {
		delete(members, sessionID)
	}
	send := r.send
	r.mu.Unlock()

	r.sfu.RemoveClient(sessionUint)

	if send != nil {
		env := &mediaproto.Envelope{
			IdempotencyKey: uuid.NewString(),
			Payload: &mediaproto.Envelope_SessionEnded{
				SessionEnded: &mediaproto.SessionEnded{
					SessionId: sessionID,
					Reason:    reason,
				},
			},
		}
		if err := send(env); err != nil {
			r.logger.Printf("[sfu-runtime] send SessionEnded for session %s: %v", sessionID, err)
		}
	}
	r.logger.Printf("[sfu-runtime] session %s closed (reason=%s)", sessionID, reason)
}

// handleSessionMove transfers a session_id between r.rooms entries when the
// Mumble user changes channels (HIGH #3). The pion PeerConnection stays
// intact — only the fanout topology changes. Idempotent if old == new.
func (r *sfuRuntime) handleSessionMove(p *mediaproto.SessionMove) {
	if p == nil || p.GetSessionId() == "" {
		return
	}
	sessionID := p.GetSessionId()
	oldRoomID := p.GetOldRoomId()
	newRoomID := p.GetNewRoomId()
	if oldRoomID == newRoomID {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state, ok := r.sessions[sessionID]
	if !ok {
		// Session unknown — at-least-once delivery may replay a SessionMove
		// after CloseSession. Silent drop is correct.
		return
	}
	// Remove from the old room (the envelope's old_room_id is advisory; we
	// trust the state's roomID as the source of truth).
	if members, has := r.rooms[state.roomID]; has {
		delete(members, sessionID)
	}
	// Install into the new room.
	if _, has := r.rooms[newRoomID]; !has {
		r.rooms[newRoomID] = make(map[string]struct{})
	}
	r.rooms[newRoomID][sessionID] = struct{}{}
	state.roomID = newRoomID
	r.logger.Printf("[sfu-runtime] session %s moved (room %s → %s)",
		sessionID, oldRoomID, newRoomID)
}

// handleSdpSignal applies an SDP coming from control. Type=="answer" closes
// out a server-initiated offer (the normal path); type=="offer" is a client-
// initiated renegotiation that media answers and sends back via SdpSignal.
func (r *sfuRuntime) handleSdpSignal(p *mediaproto.SdpSignal) {
	if p == nil || p.GetSessionId() == "" {
		return
	}
	sessionUint, ok := sessionUintFromID(p.GetSessionId())
	if !ok {
		r.sendStreamError(p.GetSessionId(), mediaproto.StreamError_CODE_MALFORMED, "non-numeric session_id")
		return
	}
	switch p.GetSdpType() {
	case "answer":
		answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: p.GetSdp()}
		if err := r.sfu.HandleAnswer(sessionUint, answer); err != nil {
			r.logger.Printf("[sfu-runtime] HandleAnswer(%s): %v", p.GetSessionId(), err)
		}
	case "offer":
		offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: p.GetSdp()}
		answer, err := r.sfu.HandleOffer(sessionUint, offer)
		if err != nil {
			r.logger.Printf("[sfu-runtime] HandleOffer(%s): %v", p.GetSessionId(), err)
			return
		}
		r.mu.RLock()
		send := r.send
		r.mu.RUnlock()
		if send != nil {
			env := &mediaproto.Envelope{
				IdempotencyKey: uuid.NewString(),
				Payload: &mediaproto.Envelope_SdpSignal{
					SdpSignal: &mediaproto.SdpSignal{
						SessionId: p.GetSessionId(),
						SdpType:   "answer",
						Sdp:       answer.SDP,
					},
				},
			}
			if err := send(env); err != nil {
				r.logger.Printf("[sfu-runtime] send SDP answer for session %s: %v", p.GetSessionId(), err)
			}
		}
	default:
		r.logger.Printf("[sfu-runtime] unknown sdp_type %q for session %s", p.GetSdpType(), p.GetSessionId())
	}
}

// handleIceCandidateSignal adds a client's trickle ICE candidate to the
// session's PeerConnection.
func (r *sfuRuntime) handleIceCandidateSignal(p *mediaproto.IceCandidateSignal) {
	if p == nil || p.GetSessionId() == "" {
		return
	}
	sessionUint, ok := sessionUintFromID(p.GetSessionId())
	if !ok {
		return
	}
	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal([]byte(p.GetCandidateJson()), &candidate); err != nil {
		r.logger.Printf("[sfu-runtime] ICE candidate parse failed for session %s: %v", p.GetSessionId(), err)
		return
	}
	if err := r.sfu.AddICECandidate(sessionUint, candidate); err != nil {
		r.logger.Printf("[sfu-runtime] AddICECandidate(%s): %v", p.GetSessionId(), err)
	}
}

// fanOutVoice forwards an inbound RTP frame from the sender to every other
// session in the same room via the SFU's ForwardToWebRTC. Each receiver
// already has an output track per sender SSRC (created in AddClient and on
// new joins in our own handler — see the OpenSession path which calls
// AddClient, which in turn pre-populates outTracks for existing peers).
//
// Receiver region is "" — phase 1 doesn't pipe per-receiver region tags;
// the metrics path treats this as unknown and counts accordingly.
func (r *sfuRuntime) fanOutVoice(roomID, senderSessionID string, senderWC *media.WebRTCClient,
	opus []byte, frameNum uint64) {
	r.mu.RLock()
	members, ok := r.rooms[roomID]
	if !ok {
		r.mu.RUnlock()
		return
	}
	// Copy peer pointers under lock; forward outside.
	peers := make([]*media.WebRTCClient, 0, len(members))
	for sid := range members {
		if sid == senderSessionID {
			continue
		}
		st, ok := r.sessions[sid]
		if !ok || st.wc == nil {
			continue
		}
		peers = append(peers, st.wc)
	}
	r.mu.RUnlock()

	for _, peer := range peers {
		r.sfu.ForwardToWebRTC(peer, senderWC.SSRC, opus, frameNum, "")
	}
}

// forwardServerICECandidate translates a pion ICE candidate into an
// IceCandidateSignal envelope and pushes it to control. A nil candidate
// means end-of-candidates; we forward it as an empty-string sentinel
// (MEDIUM #4) — the client uses this to finalize ICE rather than waiting
// for connectivity timeout.
func (r *sfuRuntime) forwardServerICECandidate(sessionID string, c *webrtc.ICECandidate) {
	r.mu.RLock()
	send := r.send
	r.mu.RUnlock()
	if send == nil {
		return
	}
	var candidateJSON string
	if c != nil {
		init := c.ToJSON()
		js, err := json.Marshal(init)
		if err != nil {
			r.logger.Printf("[sfu-runtime] ICE candidate marshal failed for session %s: %v", sessionID, err)
			return
		}
		candidateJSON = string(js)
	}
	// candidateJSON == "" when c is nil — that's the EOC sentinel; the
	// receiver side treats empty as "gathering done".
	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_IceCandidateSignal{
			IceCandidateSignal: &mediaproto.IceCandidateSignal{
				SessionId:     sessionID,
				CandidateJson: candidateJSON,
			},
		},
	}
	if err := send(env); err != nil {
		r.logger.Printf("[sfu-runtime] send IceCandidateSignal for session %s: %v", sessionID, err)
	}
}

// sendStreamError is a small helper for unrecoverable envelope failures.
func (r *sfuRuntime) sendStreamError(sessionID string, code mediaproto.StreamError_Code, msg string) {
	r.mu.RLock()
	send := r.send
	r.mu.RUnlock()
	if send == nil {
		return
	}
	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_Error{
			Error: &mediaproto.StreamError{
				Code:    code,
				Message: msg,
				ForKey:  sessionID,
			},
		},
	}
	_ = send(env)
}
