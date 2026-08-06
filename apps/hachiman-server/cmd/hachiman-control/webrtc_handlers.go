// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	"mumble.info/grumble/pkg/management"
	"mumble.info/grumble/pkg/mediaproto"
	"mumble.info/grumble/pkg/mumbleproto"
	"mumble.info/grumble/pkg/oracleclient"
)

// Phase 1 final pass: control is the signaling SHIM. The actual SFU runs on a
// hachiman-media node identified by `client.mediaNodeID`. These handlers
// translate Mumble TCP-side WebRTC / IceCandidate / TalkingState packets into
// MediaControl sidechannel envelopes (or pure broadcast in the TalkingState
// case). Inbound envelopes from media land via Server.handleMediaInbound
// (see server.go) which sends Mumble WebRTC / IceCandidate packets back to
// the client.

// handleWebRTCMessage forwards a client's SDP (answer or renegotiation offer)
// to the media node that owns the session. The actual SDP processing happens
// on media; if media generates a reply (e.g. answer to a renegotiation offer)
// it comes back as an inbound SdpSignal envelope.
func (server *Server) handleWebRTCMessage(client *Client, msg *Message) {
	webrtcMsg := &mumbleproto.WebRTC{}
	if err := proto.Unmarshal(msg.buf, webrtcMsg); err != nil {
		client.Panicf("Unable to unmarshal WebRTC message: %v", err)
		return
	}
	_, _, nodeID, sessionID := client.mediaState()
	if nodeID == "" {
		// No media node was assigned — most likely setupWebRTCForClient
		// couldn't pick one (no media nodes registered). Drop and log.
		server.Printf("WebRTC: session %d received SDP but no media node assigned; ignoring", client.Session())
		return
	}
	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_SdpSignal{
			SdpSignal: &mediaproto.SdpSignal{
				SessionId:  sessionID,
				SdpType:    webrtcMsg.GetSdpType(),
				Sdp:        webrtcMsg.GetSdp(),
				Generation: webrtcMsg.GetGeneration(),
				Seq:        webrtcMsg.GetSeq(),
			},
		},
	}
	if err := server.sendToMediaNode(nodeID, env); err != nil {
		server.Printf("WebRTC: failed to forward SDP from session %d to media node %s: %v",
			client.Session(), nodeID, err)
	}
}

// handleIceCandidateMessage forwards a client's trickle ICE candidate to the
// media node. The candidate JSON is opaque to control — the underlying
// RTCIceCandidateInit is what pion will dispatch on the media side.
func (server *Server) handleIceCandidateMessage(client *Client, msg *Message) {
	iceMsg := &mumbleproto.IceCandidate{}
	if err := proto.Unmarshal(msg.buf, iceMsg); err != nil {
		client.Panicf("Unable to unmarshal IceCandidate message: %v", err)
		return
	}
	_, _, nodeID, sessionID := client.mediaState()
	if nodeID == "" {
		server.Printf("WebRTC: session %d received ICE candidate but no media node assigned; ignoring", client.Session())
		return
	}
	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_IceCandidateSignal{
			IceCandidateSignal: &mediaproto.IceCandidateSignal{
				SessionId:     sessionID,
				CandidateJson: iceMsg.GetContent(),
				Generation:    iceMsg.GetGeneration(),
				Seq:           iceMsg.GetSeq(),
			},
		},
	}
	if err := server.sendToMediaNode(nodeID, env); err != nil {
		server.Printf("WebRTC: failed to forward ICE candidate from session %d to media node %s: %v",
			client.Session(), nodeID, err)
	}
}

// handleTalkingStateMessage broadcasts a client's talking-state change to all
// other clients in the server. This is a pure UI-layer broadcast (an "I'm
// speaking" indicator); the SFU does its own talking detection on the audio
// path and reports separately via the media→control TalkingStateChanged
// envelope. For phase 1 the client-driven broadcast is sufficient — receivers
// see the indicator the moment the speaker presses PTT, without waiting for
// the audio path to debounce.
func (server *Server) handleTalkingStateMessage(client *Client, msg *Message) {
	tsMsg := &mumbleproto.TalkingState{}
	if err := proto.Unmarshal(msg.buf, tsMsg); err != nil {
		client.Panicf("Unable to unmarshal TalkingState message: %v", err)
		return
	}
	target := tsMsg.GetTarget()

	tsBroadcast := &mumbleproto.TalkingState{
		Session: proto.Uint32(client.Session()),
		Target:  proto.Uint32(target),
	}
	for _, other := range server.clients {
		if other == client {
			continue
		}
		if err := other.sendMessage(tsBroadcast); err != nil {
			other.Panicf("Failed to send TalkingState: %v", err)
		}
	}
}

// setupWebRTCForClient picks a media node from the registry and pushes an
// OpenSession envelope. The SDP offer arrives asynchronously back on the
// sidechannel (SdpSignal envelope) and is delivered to the client via
// handleMediaInbound → Mumble WebRTC packet.
//
// CRITICAL: this MUST run on the handlerLoop goroutine (called from
// finishAuthenticate, not from the per-client authenticate goroutine).
// Otherwise the OpenSession envelope is sent before server.clients has the
// client, and media's near-instant SdpSignal reply gets dropped because the
// dispatcher can't find the client.
//
// SSRC ALLOCATION DECISION: for phase 1 we use the Mumble session uint as the
// SSRC. They're allocated by the existing SessionPool, unique across the
// vServer's lifetime, and BOTH sides agree on this identity (CRITICAL #1 fix).
// We leave webrtcSSRC at 0 here and only stamp it after SessionEstablished
// echoes back from media — so the UserState broadcast that names the SSRC
// happens AFTER media has confirmed allocation. UserState is broadcast at the
// end of finishAuthenticate, which is after this call returns; the SSRC is
// already echoed by then in the steady-state path.
//
// VOICE TOKEN: phase 1 leaves the token bytes empty. The pkg/voicetoken
// signer expects a real DTLS fingerprint, which the client doesn't send yet
// (that's the VoiceTokenRequest flow that phase 2 only proto-defined and
// phase 4 will wire up on the client side). Media accepts empty tokens in
// the embedded / dev configuration; production deploys will require both
// sides to land the VoiceTokenRequest pipeline before going live. Tracked as
// a phase-1 follow-up.
//
// RENEGOTIATION DIRECTION DECISION: with the SFU on media, ANY future change
// to the publisher/subscriber matrix (member join → new outbound track) is a
// media-initiated renegotiation. Media generates a fresh offer and pushes it
// via SdpSignal{type:"offer"}; control delivers it; client answers; control
// forwards the answer via SdpSignal{type:"answer"}. Control never asks media
// to renegotiate — there's nothing for control to ask about (it has no SFU
// state). The renegotiation-on-join logic lives in hachiman-media's
// sfu_runtime.go handleOpenSession (CRITICAL #3 fix).
//
// MULTI-VSERVER ROUTING: the session_id is prefixed with the vServer id so
// inbound envelopes can be routed back to the right vServer even in a
// multi-server process (CRITICAL #5 fix). Format: `<vServerID>:<mumbleSession>`.
func (server *Server) setupWebRTCForClient(client *Client) error {
	if server.registry == nil {
		// No back-pointer to the global registry — this is the embedded /
		// pre-split posture. WebRTC is unavailable; surface as a soft
		// warning, leave the Mumble TCP session alive for text chat.
		server.Printf("WebRTC: session %d requested WebRTC but server has no media registry; text-only session", client.Session())
		return nil
	}
	mediaLis := server.registry.MediaSidechannel()
	if mediaLis == nil {
		server.Printf("WebRTC: session %d requested WebRTC but --media-sidechannel-addr is disabled; text-only session", client.Session())
		return nil
	}
	// Placement: Oracle is the source of truth when --oracle-addr is wired;
	// the in-memory pickNode() is the dev / Oracle-unreachable fallback. The
	// local registry stays the dispatch index either way — its sendTo() is
	// how the OpenSession envelope actually reaches media.
	nodeID, assignedSSRC := server.placeMediaSession(client)
	if nodeID == "" {
		server.Printf("WebRTC: session %d requested WebRTC but no media nodes available; text-only session", client.Session())
		return nil
	}
	_ = assignedSSRC // phase 3a: Oracle's assigned_ssrc is captured but the
	// session/SSRC mapping is still driven by the SessionEstablished echo
	// (CRITICAL #1 fix). Phase 4 plumbs assignedSSRC into the VoiceTokenGrant
	// claim that media validates against.

	// Phase 1 multi-vServer routing: prefix vServerID into the session_id
	// string. Media stores it opaquely; only control parses the prefix on
	// inbound to route to the right vServer.
	mumbleSession := client.Session()
	sessionIDStr := fmt.Sprintf("%d:%d", server.Id, mumbleSession)
	roomID := ""
	if client.Channel != nil {
		roomID = fmt.Sprintf("%d", client.Channel.Id)
	}

	// Stamp media-session bookkeeping BEFORE sending OpenSession so an
	// envelope racing back from media (microseconds later) finds the
	// fields populated. SSRC stays 0 until SessionEstablished echoes it.
	client.setMediaSession(nodeID, sessionIDStr, 0)

	// TODO(phase 4): mint VoiceTokenGrant here and push it to the client over
	// the Mumble TCP control channel. The grant carries:
	//   - VoiceTokenGrant.token: PASETO bytes from pkg/voicetoken.Signer.MintToken(claims)
	//   - VoiceTokenGrant.ice_servers: coturn.CoturnConfig.MintICEServers(
	//         channelHomeRegion, fmt.Sprintf("%d", client.UserId()), time.Now())
	//   - VoiceTokenGrant.assigned_ssrc: the SSRC media echoes in SessionEstablished
	//   - VoiceTokenGrant.media_node_addr / media_node_id: from registry / Oracle
	// The mint depends on the client's DTLS fingerprint, which arrives via the
	// VoiceTokenRequest Mumble message that phase 2 proto-defined and phase 4
	// will wire on the client side (follow-up #12). Until then OpenSession
	// carries an empty token and media accepts it in dev mode.
	//
	// The mint path will call:
	//   if reg := server.registry; reg != nil {
	//       if cfg := reg.CoturnConfig(); cfg != nil {
	//           grant.IceServers = cfg.MintICEServers(homeRegion, userIDStr, time.Now())
	//       }
	//   }
	// MintICEServers returns nil for unknown regions / nil config, which is
	// the documented contract (client falls back to host + srflx).

	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_OpenSession{
			OpenSession: &mediaproto.OpenSession{
				SessionId:       sessionIDStr,
				RoomId:          roomID,
				UserId:          fmt.Sprintf("%d", client.UserId()),
				DtlsFingerprint: "", // phase 1: client doesn't send it yet
				IceUfrag:        "", // same — comes with VoiceTokenRequest
				Ssrc:            mumbleSession,
				VoiceToken:      nil, // phase 1: empty; phase 2 wires token signer
				ExpiresAtUnix:   0,   // phase 1: no token, no expiry
			},
		},
	}
	if err := mediaLis.Registry().sendTo(nodeID, env); err != nil {
		// Roll back the state stash so subsequent flows don't think a session
		// was opened.
		client.clearMediaSession()
		server.Printf("WebRTC: OpenSession dispatch to media node %s failed for session %d: %v",
			nodeID, mumbleSession, err)
		// Fall through with nil — the Mumble TCP session continues; the
		// client will simply never receive a WebRTC offer and degrades to
		// text-only.
		return nil
	}
	server.Printf("WebRTC: session %d → media node %s (room %s, ssrc %d)",
		mumbleSession, nodeID, roomID, mumbleSession)
	return nil
}

// sendCloseSession pushes a CloseSession envelope when a client disconnects.
// Best-effort: if the media node is gone we just log; the media-side eviction
// will catch up on its own via stream EOF.
func (server *Server) sendCloseSession(client *Client) {
	if server.registry == nil {
		return
	}
	_, _, nodeID, sessionID := client.mediaState()
	if nodeID == "" || sessionID == "" {
		return
	}
	mediaLis := server.registry.MediaSidechannel()
	if mediaLis == nil {
		return
	}
	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_CloseSession{
			CloseSession: &mediaproto.CloseSession{
				SessionId: sessionID,
			},
		},
	}
	if err := mediaLis.Registry().sendTo(nodeID, env); err != nil {
		server.Printf("WebRTC: CloseSession dispatch for session %d failed: %v",
			client.Session(), err)
	}
}

// sendSessionMove tells media that this client moved to a new channel
// (HIGH #3). Media moves the session between r.rooms entries; no peer
// renegotiation needed.
func (server *Server) sendSessionMove(client *Client, oldRoomID, newRoomID string) {
	if server.registry == nil {
		return
	}
	enabled, _, nodeID, sessionID := client.mediaState()
	if !enabled || nodeID == "" || sessionID == "" {
		return
	}
	if oldRoomID == newRoomID {
		return
	}
	mediaLis := server.registry.MediaSidechannel()
	if mediaLis == nil {
		return
	}
	env := &mediaproto.Envelope{
		IdempotencyKey: uuid.NewString(),
		Payload: &mediaproto.Envelope_SessionMove{
			SessionMove: &mediaproto.SessionMove{
				SessionId:  sessionID,
				OldRoomId:  oldRoomID,
				NewRoomId:  newRoomID,
			},
		},
	}
	if err := mediaLis.Registry().sendTo(nodeID, env); err != nil {
		server.Printf("WebRTC: SessionMove dispatch for session %d (%s → %s) failed: %v",
			client.Session(), oldRoomID, newRoomID, err)
	}
}

// sendToMediaNode is a thin wrapper that goes through the back-pointer to
// reach the sidechannel registry. Inlined into each handler would be a few
// lines shorter but the central error path is worth the indirection.
func (server *Server) sendToMediaNode(nodeID string, env *mediaproto.Envelope) error {
	if server.registry == nil {
		return errNoMediaNode
	}
	mediaLis := server.registry.MediaSidechannel()
	if mediaLis == nil {
		return errNoMediaNode
	}
	return mediaLis.Registry().sendTo(nodeID, env)
}

// handleMediaInbound translates an inbound media-sidechannel envelope into a
// Mumble TCP-side wire effect on the matching client. Runs on the vServer's
// handlerLoop goroutine (called from server.go's select on mediaInbound) so
// it can read/write server.clients without locking. The per-client `mediaMu`
// is still required because the per-client disconnect path
// (sendCloseSession) and the eviction sweeper read the same fields from
// other goroutines.
func (server *Server) handleMediaInbound(job mediaInboundJob) {
	// HIGH #2: node-eviction broadcast doesn't target a specific session;
	// fan out across every client on the vServer that was bound to the
	// evicted node.
	if job.evict {
		server.handleNodeEviction(job.nodeID)
		return
	}
	client, ok := server.clients[job.session]
	if !ok {
		// Client gone (disconnected before media's reply landed). Drop.
		return
	}
	switch payload := job.envelope.GetPayload().(type) {
	case *mediaproto.Envelope_SdpSignal:
		sig := payload.SdpSignal
		mumbleMsg := &mumbleproto.WebRTC{
			Sdp:        proto.String(sig.GetSdp()),
			SdpType:    proto.String(sig.GetSdpType()),
			SessionId:  proto.String(sig.GetSessionId()),
			Generation: proto.Uint32(sig.GetGeneration()),
			Seq:        proto.Uint32(sig.GetSeq()),
		}
		if err := client.sendMessage(mumbleMsg); err != nil {
			server.Printf("WebRTC: failed to send SDP to session %d: %v", client.Session(), err)
		}
	case *mediaproto.Envelope_IceCandidateSignal:
		sig := payload.IceCandidateSignal
		mumbleMsg := &mumbleproto.IceCandidate{
			Content:    proto.String(sig.GetCandidateJson()),
			SessionId:  proto.String(sig.GetSessionId()),
			Generation: proto.Uint32(sig.GetGeneration()),
			Seq:        proto.Uint32(sig.GetSeq()),
		}
		if err := client.sendMessage(mumbleMsg); err != nil {
			server.Printf("WebRTC: failed to send ICE candidate to session %d: %v", client.Session(), err)
		}
	case *mediaproto.Envelope_SessionEstablished:
		// Phase 1 final pass CRITICAL #1: media echoes the SSRC it actually
		// assigned; control records it so future UserState broadcasts /
		// SubscriptionMatrix work agree with the value the SFU forwards
		// under.
		ssrc := payload.SessionEstablished.GetSsrc()
		if ssrc != 0 {
			client.setMediaSSRC(ssrc)
			// Re-broadcast the user's SSRC so peers who joined before the
			// echo land also pick it up. Cheap: UserState is small.
			broadcastUserSSRC(server, client, ssrc)
		}
		// Hand off the pending-reclaim bookkeeping: presence in pending +
		// SessionEstablished is benign (we wait for SessionEnded). No-op
		// here; the SessionEnded handler is what drives Reclaim.
	case *mediaproto.Envelope_SessionEnded:
		// Media tore the session down (client disconnected from media's
		// perspective, ICE failed, etc.). Clear the bookkeeping so a
		// subsequent reconnect re-runs setupWebRTCForClient cleanly.
		client.clearMediaSession()
		// Now it is safe to recycle the Mumble session number — the SFU
		// peer has been fully closed.
		server.reclaimPendingSession(client.Session())
	}
}

// placeMediaSession picks the media node for a new client session. Wraps the
// pure helper choosePlacement with the per-vServer Server / Client context.
func (server *Server) placeMediaSession(client *Client) (nodeID string, assignedSSRC uint32) {
	registry := server.registry
	if registry == nil {
		return "", 0
	}
	mediaLis := registry.MediaSidechannel()
	if mediaLis == nil {
		return "", 0
	}
	mediaRegistry := mediaLis.Registry()
	var channelID uint64
	if client.Channel != nil {
		channelID = uint64(client.Channel.Id)
	}
	return choosePlacement(placementInputs{
		oracle:        registry.OracleClient(),
		localPickNode: mediaRegistry.pickNode,
		localHas:      func(id string) bool { return mediaRegistry.get(id) != nil },
		channelID:     channelID,
		homeRegion:    server.cfg.StringValue("ServerRegion"),
		tenantID:      "", // phase 3a — see comment on placementInputs.tenantID
		logf:          server.Printf,
	})
}

// placementInputs is the dependency-injection shape for choosePlacement —
// the bits the helper needs without depending on *Server. Lets the test
// exercise Oracle/fallback paths without the boot machinery.
//
// tenantID is intentionally empty in phase 3a. Control's tenant model isn't
// fully threaded through; Oracle's single-tenant-per-node rule will be
// expressed by stamping the real tenant from channel/server config in phase 4.
type placementInputs struct {
	oracle        oracleClient                       // nil = fallback only
	localPickNode func() string                      // returns "" if no live nodes
	localHas      func(string) bool                  // does the local registry have this node?
	channelID     uint64                             // channel id, for the placement request
	homeRegion    string                             // server's ServerRegion config
	tenantID      string                             // phase 3a: empty
	logf          func(format string, v ...interface{}) // server's Printf, or t.Logf in tests
}

// choosePlacement runs the placement decision. Oracle is consulted when wired;
// on ErrUnconfigured / unreachable / empty response / drift between Oracle and
// the local dispatch index, the local pickNode() fallback fires. assignedSSRC
// is non-zero only on the Oracle-success path.
func choosePlacement(in placementInputs) (string, uint32) {
	fallback := ""
	if in.localPickNode != nil {
		fallback = in.localPickNode()
	}
	if in.oracle == nil {
		return fallback, 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), placeMediaSessionTimeout)
	defer cancel()
	resp, err := in.oracle.PlaceMediaSession(ctx, &management.PlaceMediaSessionRequest{
		ChannelId:  in.channelID,
		HomeRegion: in.homeRegion,
		TenantId:   in.tenantID,
	})
	if err != nil {
		if errors.Is(err, oracleclient.ErrUnconfigured) {
			return fallback, 0
		}
		if in.logf != nil {
			in.logf("WebRTC: Oracle PlaceMediaSession failed (channel=%d region=%q): %v; falling back to local pickNode",
				in.channelID, in.homeRegion, err)
		}
		return fallback, 0
	}
	if resp.GetNodeId() == "" {
		return fallback, 0
	}
	// Drift check: the local registry is the dispatch index. If Oracle picks
	// a node we don't actually have a sidechannel to, the dispatch would fail
	// — fall back. The next heartbeat mirror reconciles Oracle's view.
	if in.localHas != nil && !in.localHas(resp.GetNodeId()) {
		if in.logf != nil {
			in.logf("WebRTC: Oracle returned node %q not in local registry; falling back to local pickNode",
				resp.GetNodeId())
		}
		return fallback, 0
	}
	return resp.GetNodeId(), resp.GetAssignedSsrc()
}

// placeMediaSessionTimeout bounds the Oracle round-trip at session setup.
//
// Why 200ms: choosePlacement runs on the per-vServer handlerLoop, which is
// single-threaded over every connected client. A blocking Oracle call
// freezes ALL other client work on that vServer for the duration. Oracle
// is expected to respond in tens of ms when healthy; 200ms is a generous
// tail that still keeps the blast radius bounded — any longer and one
// laggy Oracle starves message dispatch for every concurrent join.
//
// On timeout the caller (choosePlacement) falls back to the local
// in-memory registry's pickNode(), which is the same path used when
// --oracle-addr is empty. The session-establishment p95 ≤ 2s SLO from
// MEDIA-PLANE-MIGRATION.md is still met: 200ms cap + local fallback +
// rest of the handshake fits comfortably.
//
// Phase 3a follow-up: the proper fix is to dispatch placement off the
// handlerLoop (e.g. via mediaInbound async) so a slow Oracle never blocks
// the loop at all. That refactor is bigger and lands later — for now the
// shorter timeout bounds the worst case.
const placeMediaSessionTimeout = 200 * time.Millisecond

// broadcastUserSSRC sends a UserState{session, ssrc} update to all connected
// clients so they know which SSRC the new joiner's audio will arrive on.
// Called once SessionEstablished echoes the assigned SSRC. Safe to call from
// the handlerLoop; iterates server.clients without locking because the
// handlerLoop is its writer.
func broadcastUserSSRC(server *Server, client *Client, ssrc uint32) {
	msg := &mumbleproto.UserState{
		Session: proto.Uint32(client.Session()),
		Ssrc:    proto.Uint32(ssrc),
	}
	for _, other := range server.clients {
		if other.state < StateClientAuthenticated {
			continue
		}
		_ = other.sendMessage(msg)
	}
}
