// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"log"
	"strconv"
	"strings"
	"sync"

	"google.golang.org/protobuf/proto"

	"mumble.info/grumble/pkg/coturn"
	"mumble.info/grumble/pkg/mediaproto"
	"mumble.info/grumble/pkg/mumbleproto"
)

// ServerRegistry is a thread-safe, in-process registry of currently running
// virtual servers keyed by Server.Id. It is populated when servers are loaded
// at boot (existing flow in main()) AND when the management gRPC API creates a
// new vServer at runtime. The Oracle control plane uses the management API to
// drive this — see pkg/management/.
//
// The registry stays inside cmd/grumble (next to Server) so it can hold the
// concrete *Server type without an import cycle. The management service in
// pkg/management/ talks to it through a VServerLifecycle interface.
type ServerRegistry struct {
	mu      sync.RWMutex
	servers map[int64]*Server

	// mediaSidechannel is the listener that owns the in-memory media-node
	// registry. Set once at boot (in grumble.go) when --media-sidechannel-addr
	// is non-empty; nil in the embedded / disabled case. Used by per-server
	// webrtc_handlers.go to dispatch OpenSession / SdpSignal / etc. envelopes.
	// Lifetime is the lifetime of the control process; no Unset hook needed.
	mediaSidechannel *mediaSidechannelListener

	// coturnCfg is the per-region TURN config loaded at boot from
	// --coturn-config. Nil = no TURN configured; MintICEServers on nil is
	// a safe no-op returning nil. Held on the registry so per-server
	// webrtc_handlers.go (which already reaches the registry for the
	// sidechannel) can call MintICEServers at VoiceTokenGrant mint time.
	coturnCfg *coturn.CoturnConfig

	// oracle is the Oracle gRPC client used for media-node registration
	// mirroring + placement queries. Nil = Oracle unwired (--oracle-addr
	// empty); callers fall back to local pickNode(). Held here so per-
	// server code paths can reach it via the same back-pointer.
	oracle oracleClient
}

func NewServerRegistry() *ServerRegistry {
	return &ServerRegistry{
		servers: make(map[int64]*Server),
	}
}

// Register adds a server to the registry. Calling Register twice for the same
// Id replaces the previous entry (callers should Unregister first if that
// matters). The back-pointer is wired here so the server can reach the
// MediaControl sidechannel via the registry.
func (r *ServerRegistry) Register(s *Server) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.servers[s.Id] = s
	s.registry = r
}

// Unregister removes a server from the registry. No-op if the id isn't
// registered.
func (r *ServerRegistry) Unregister(id int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.servers, id)
}

// Get returns the registered server for id, or (nil, false) if no such id is
// registered.
func (r *ServerRegistry) Get(id int64) (*Server, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.servers[id]
	return s, ok
}

// List returns a snapshot slice of all registered servers. Safe to iterate
// without holding the lock.
func (r *ServerRegistry) List() []*Server {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Server, 0, len(r.servers))
	for _, s := range r.servers {
		out = append(out, s)
	}
	return out
}

// Exists reports whether a server with the given id is currently registered.
func (r *ServerRegistry) Exists(id int64) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.servers[id]
	return ok
}

// SetMediaSidechannel records the listener so per-server webrtc_handlers can
// push OpenSession / SdpSignal envelopes via it. Called once at boot if
// --media-sidechannel-addr was non-empty. Subsequent calls overwrite.
func (r *ServerRegistry) SetMediaSidechannel(l *mediaSidechannelListener) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.mediaSidechannel = l
}

// MediaSidechannel returns the listener if one was wired up, or nil if the
// control process started without --media-sidechannel-addr. Callers (typically
// webrtc_handlers) treat nil as "WebRTC unavailable — no media node path".
func (r *ServerRegistry) MediaSidechannel() *mediaSidechannelListener {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.mediaSidechannel
}

// SetCoturnConfig stashes the per-region coturn config so VoiceTokenGrant
// mint paths can call CoturnConfig.MintICEServers. Set once at boot; nil
// for --coturn-config empty (no TURN). Subsequent calls overwrite.
func (r *ServerRegistry) SetCoturnConfig(cfg *coturn.CoturnConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.coturnCfg = cfg
}

// CoturnConfig returns the per-region TURN config, or nil if no --coturn-config
// was set at boot. Callers treat nil the same as empty: VoiceTokenGrant
// ice_servers stays empty and the client falls back to host / srflx ICE only.
func (r *ServerRegistry) CoturnConfig() *coturn.CoturnConfig {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.coturnCfg
}

// SetOracleClient stashes the Oracle gRPC client. Set once at boot; nil for
// --oracle-addr empty (Oracle unwired — local registry is authoritative).
// Subsequent calls overwrite.
func (r *ServerRegistry) SetOracleClient(c oracleClient) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oracle = c
}

// OracleClient returns the Oracle gRPC client, or nil if --oracle-addr was
// empty at boot. Callers treat nil as "fall back to local pickNode()" for
// placement and skip the mirror entirely for registration / heartbeats.
func (r *ServerRegistry) OracleClient() oracleClient {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.oracle
}

// parseMediaSessionID parses a media-side session id back into its (vServer,
// mumbleSession) components. The wire format is `<vServerID>:<mumbleSession>`
// (see setupWebRTCForClient in webrtc_handlers.go) — CRITICAL #5. Returns
// (0, 0, false) on malformed input.
func parseMediaSessionID(sessionID string) (vServerID int64, mumbleSession uint32, ok bool) {
	idx := strings.IndexByte(sessionID, ':')
	if idx < 0 {
		return 0, 0, false
	}
	vID, err := strconv.ParseInt(sessionID[:idx], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	ms, err := strconv.ParseUint(sessionID[idx+1:], 10, 32)
	if err != nil {
		return 0, 0, false
	}
	return vID, uint32(ms), true
}

// serverForSession finds the vServer hosting the given session_id (after
// CRITICAL #5: the id is `<vServerID>:<mumbleSession>`). Returns nil for an
// unknown vServer.
func (r *ServerRegistry) serverForSession(sessionID string) *Server {
	vID, _, ok := parseMediaSessionID(sessionID)
	if !ok {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.servers[vID]
}

// HandleMediaInbound implements mediaInboundDispatcher (defined in
// media_registry.go). Called from the sidechannel goroutine for each
// SdpSignal / IceCandidateSignal / SessionEstablished / SessionEnded envelope.
//
// It parses the session_id, locates the owning vServer, and enqueues an
// mediaInboundJob on that server's mediaInbound channel. The actual client-
// side wire effect (sending a Mumble WebRTC / IceCandidate packet) runs on the
// vServer's handlerLoop goroutine — see handleMediaInbound in server.go.
//
// Logging-only routing failures (unknown session, registry empty) — the media
// node MAY emit envelopes for sessions whose Mumble TCP has already torn down,
// and dropping them is the right behaviour.
func (r *ServerRegistry) HandleMediaInbound(nodeID string, env *mediaproto.Envelope) {
	sessionID := mediaInboundSessionID(env)
	if sessionID == "" {
		return
	}
	vID, mumbleSession, ok := parseMediaSessionID(sessionID)
	if !ok {
		log.Printf("[media-inbound] node %s sent envelope with malformed session_id %q; ignoring", nodeID, sessionID)
		return
	}
	r.mu.RLock()
	srv := r.servers[vID]
	r.mu.RUnlock()
	if srv == nil {
		log.Printf("[media-inbound] node %s sent envelope for vServer %d (session %s) but vServer not registered; ignoring",
			nodeID, vID, sessionID)
		return
	}
	job := mediaInboundJob{
		nodeID:   nodeID,
		session:  mumbleSession,
		envelope: env,
	}
	ch := derefMediaInbound(&srv.mediaInbound)
	if ch == nil {
		// vServer is shutting down — drop and move on.
		srv.recordMediaInboundDrop()
		return
	}
	// Non-blocking enqueue: if the handler goroutine is overwhelmed we drop
	// the envelope rather than back-pressure the sidechannel for the WHOLE
	// fleet. HIGH #1: the drop is counted on the vServer so ops can alert.
	select {
	case ch <- job:
	default:
		srv.recordMediaInboundDrop()
		log.Printf("[media-inbound] vServer %d mediaInbound queue full; dropping payload %s from node %s (dropped_total=%d)",
			srv.Id, payloadTag(env), nodeID, srv.MediaInboundDropped())
	}
}

// NodeEvicted is called from the media registry's eviction paths (stream EOF
// and the sweeper) to inform the vServer registry that all clients bound to
// nodeID have lost their SFU peer. HIGH #2: walks every vServer, finds the
// matching clients, clears their media bookkeeping, and broadcasts a
// UserState update zeroing the SSRC. Phase 1 does cleanup-only — re-placing
// the session on a different media node is a phase 3 cascade-aware concern.
func (r *ServerRegistry) NodeEvicted(nodeID string) {
	if nodeID == "" {
		return
	}
	// Snapshot the vServer slice under the lock; the per-vServer dispatch
	// happens without holding the registry lock so we don't block placement.
	r.mu.RLock()
	servers := make([]*Server, 0, len(r.servers))
	for _, s := range r.servers {
		servers = append(servers, s)
	}
	r.mu.RUnlock()

	for _, srv := range servers {
		// Enqueue an evict job on the vServer's handler loop so the actual
		// client-map walk + broadcast runs on the same goroutine as every
		// other clients-map writer. If the channel is full we record the
		// drop and move on; the next eviction sweep will retry.
		ch := derefMediaInbound(&srv.mediaInbound)
		if ch == nil {
			continue
		}
		evictJob := mediaInboundJob{
			nodeID: nodeID,
			evict:  true,
		}
		select {
		case ch <- evictJob:
		default:
			srv.recordMediaInboundDrop()
			log.Printf("[media-inbound] vServer %d mediaInbound queue full while delivering node-eviction (node=%s)",
				srv.Id, nodeID)
		}
	}
}

// handleNodeEviction runs on the handlerLoop goroutine and clears media
// bookkeeping for every client bound to the evicted node. Called from
// handleMediaInbound when an evict-job is dequeued.
func (server *Server) handleNodeEviction(nodeID string) {
	var cleared int
	for _, client := range server.clients {
		if client.mediaNode() != nodeID {
			continue
		}
		client.clearMediaSession()
		// Broadcast a UserState update zeroing the SSRC so other clients
		// know audio fanout for this session has stopped.
		msg := &mumbleproto.UserState{
			Session: proto.Uint32(client.Session()),
			Ssrc:    proto.Uint32(0),
		}
		for _, other := range server.clients {
			if other.state < StateClientAuthenticated {
				continue
			}
			_ = other.sendMessage(msg)
		}
		cleared++
	}
	if cleared > 0 {
		server.Printf("WebRTC: media node %s evicted; cleared %d client session(s)", nodeID, cleared)
	}
}

// mediaInboundSessionID pulls the session_id out of any of the dispatchable
// payload types. Returns "" for payloads that don't carry one.
func mediaInboundSessionID(env *mediaproto.Envelope) string {
	switch p := env.GetPayload().(type) {
	case *mediaproto.Envelope_SdpSignal:
		return p.SdpSignal.GetSessionId()
	case *mediaproto.Envelope_IceCandidateSignal:
		return p.IceCandidateSignal.GetSessionId()
	case *mediaproto.Envelope_SessionEstablished:
		return p.SessionEstablished.GetSessionId()
	case *mediaproto.Envelope_SessionEnded:
		return p.SessionEnded.GetSessionId()
	}
	return ""
}

// payloadTag returns a short string tag for the envelope's payload type.
// Used in log lines (replaces the verbose `%T` print) — L4 follow-up.
func payloadTag(env *mediaproto.Envelope) string {
	switch env.GetPayload().(type) {
	case *mediaproto.Envelope_SdpSignal:
		return "sdp_signal"
	case *mediaproto.Envelope_IceCandidateSignal:
		return "ice_candidate_signal"
	case *mediaproto.Envelope_SessionEstablished:
		return "session_established"
	case *mediaproto.Envelope_SessionEnded:
		return "session_ended"
	case *mediaproto.Envelope_SessionMove:
		return "session_move"
	case *mediaproto.Envelope_Heartbeat:
		return "heartbeat"
	case *mediaproto.Envelope_Ack:
		return "ack"
	case *mediaproto.Envelope_Error:
		return "error"
	}
	return "unknown"
}

// mediaInboundJob is the unit of work pushed onto a vServer's mediaInbound
// channel. The handler goroutine pops it and dispatches based on payload
// type. The `evict` flag short-circuits envelope dispatch to a node-eviction
// fanout (HIGH #2).
type mediaInboundJob struct {
	nodeID   string
	session  uint32
	envelope *mediaproto.Envelope
	evict    bool
}
