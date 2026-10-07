// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/coturn"
	"hachiman/server/pkg/takusenclient"
	"hachiman/server/pkg/voicetoken"
)

// Opcodes and close codes, contract §6.
const (
	opDispatch       = 0
	opHeartbeat      = 1
	opIdentify       = 2
	opPresenceUpdate = 3
	opVoiceState     = 4
	opDocAwareness   = 5
	opResume         = 6
	opInvalidSession = 9
	opHello          = 10
	opHeartbeatAck   = 11

	closeUnknownError     = 4000
	closeUnknownOpcode    = 4001
	closeDecodeError      = 4002
	closeNotAuthenticated = 4003
	closeAuthFailed       = 4004
	closeAlreadyAuthed    = 4005
	closeInvalidSeq       = 4007
	closeSessionTimeout   = 4009
	closeUnsupported      = 4012
	closeDeviceRevoked    = 4013
)

// Frame limits, contract §6.
const (
	maxFrameBytes        = 65536 // larger frames close the socket with 1009
	maxAwarenessEnvelope = 8192  // characters of an op 5 envelope (MAX_DOC_AWARENESS_B64_BYTES)
	awarenessPerSecond   = 20    // op 5 token bucket: burst and refill rate
)

// capabilityE2EE is the IDENTIFY capability every client must send (§12.13).
const capabilityE2EE = "e2ee/1"

type Gateway struct {
	rdb        *redis.Client
	takusenURL string
	http       *http.Client
	placer     *takusenclient.Client
	signer     *voicetoken.Signer
	turn       *coturn.CoturnRegion // nil = STUN only

	// Postgres reads; function fields so tests can run without a database.
	load    func(ctx context.Context, userID, onlyGuild string) (*readyData, error)
	nodeURL func(ctx context.Context, nodeID string) (string, error)
	device  func(ctx context.Context, deviceID string) (deviceRow, error)

	minClientVersion semver

	heartbeat       time.Duration
	identifyTimeout time.Duration
	offlineGrace    time.Duration
	now             func() time.Time // the op 5 rate-limit clock; tests replace it

	busReady chan struct{}
	mu       sync.RWMutex
	sessions map[string]*session
	byGuild  map[string]map[*session]struct{}
	byUser   map[string]map[*session]struct{}
	byDevice map[string]map[*session]struct{}
}

func newGateway(rdb *redis.Client, takusenURL string, placer *takusenclient.Client, signer *voicetoken.Signer) *Gateway {
	return &Gateway{
		rdb: rdb, takusenURL: takusenURL, placer: placer, signer: signer,
		http:             &http.Client{Timeout: 5 * time.Second},
		heartbeat:        41250 * time.Millisecond,
		identifyTimeout:  10 * time.Second,
		offlineGrace:     60 * time.Second,
		now:              time.Now,
		minClientVersion: semver{0, 1, 0, nil},
		busReady:         make(chan struct{}),
		sessions:         map[string]*session{},
		byGuild:          map[string]map[*session]struct{}{},
		byUser:           map[string]map[*session]struct{}{},
		byDevice:         map[string]map[*session]struct{}{},
	}
}

// Tokens are bearer-authenticated, not cookie-authenticated, so a
// cross-origin page gains nothing by opening the socket; any Origin is fine.
var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func (g *Gateway) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := g.rdb.Ping(r.Context()).Err(); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/gateway", g.serveWS)
	return mux
}

// conn serialises writes through one goroutine; everything else only enqueues.
type conn struct {
	ws     *websocket.Conn
	out    chan []byte
	done   chan struct{}
	once   sync.Once
	code   int
	reason string
}

func newConn(ws *websocket.Conn) *conn {
	c := &conn{ws: ws, out: make(chan []byte, 256), done: make(chan struct{})}
	go c.writeLoop()
	return c
}

func (c *conn) send(b []byte) {
	select {
	case c.out <- b:
	case <-c.done:
	default:
		c.close(closeUnknownError, "send buffer full")
	}
}

func (c *conn) sendOp(op int, d any) {
	b, _ := json.Marshal(struct {
		Op int `json:"op"`
		D  any `json:"d"`
	}{op, d})
	c.send(b)
}

// close is idempotent; code 0 means "peer already gone, just drop the socket".
func (c *conn) close(code int, reason string) {
	c.once.Do(func() {
		c.code, c.reason = code, reason
		close(c.done)
	})
}

func (c *conn) writeLoop() {
	defer c.ws.Close()
	write := func(b []byte) bool {
		_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return c.ws.WriteMessage(websocket.TextMessage, b) == nil
	}
	for {
		select {
		case b := <-c.out:
			if !write(b) {
				c.close(0, "")
				return
			}
		case <-c.done:
			for len(c.out) > 0 { // flush e.g. INVALID_SESSION queued just before the close
				if !write(<-c.out) {
					return
				}
			}
			if c.code != 0 {
				_ = c.ws.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(c.code, c.reason), time.Now().Add(time.Second))
			}
			return
		}
	}
}

type inFrame struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
}

func (g *Gateway) serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(maxFrameBytes) // gorilla sends close 1009 on overflow
	c := newConn(ws)
	c.sendOp(opHello, map[string]int64{"heartbeatInterval": g.heartbeat.Milliseconds()})
	s := g.handshake(c)
	if s == nil {
		return
	}
	g.readLoop(c, s)
}

// read returns the next frame, or ok=false after closing c with the right
// code. bye reports a clean 1000 close: the client called disconnect() and
// won't RESUME, so there is no point holding presence/voice for the grace.
func (g *Gateway) read(c *conn, timeoutCode int) (f inFrame, ok, bye bool) {
	_, b, err := c.ws.ReadMessage()
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			c.close(timeoutCode, "timed out")
		} else {
			c.close(0, "")
		}
		return f, false, websocket.IsCloseError(err, websocket.CloseNormalClosure)
	}
	if err := json.Unmarshal(b, &f); err != nil {
		c.close(closeDecodeError, "decode error")
		return f, false, false
	}
	return f, true, false
}

// handshake runs until IDENTIFY or RESUME succeeds. INVALID_SESSION keeps the
// socket open so the client can IDENTIFY on it (Discord semantics).
func (g *Gateway) handshake(c *conn) *session {
	_ = c.ws.SetReadDeadline(time.Now().Add(g.identifyTimeout))
	for {
		f, ok, _ := g.read(c, closeNotAuthenticated)
		if !ok {
			return nil
		}
		var s *session
		var err error
		switch f.Op {
		case opHeartbeat:
			c.sendOp(opHeartbeatAck, nil)
			continue
		case opIdentify:
			s, err = g.identify(c, f.D)
		case opResume:
			s, err = g.resume(c, f.D)
		default:
			c.close(closeNotAuthenticated, "not authenticated")
			return nil
		}
		var ce closeErr
		switch {
		case errors.As(err, &ce):
			c.close(ce.code, ce.msg)
			return nil
		case err != nil:
			slog.Warn("handshake failed", "op", f.Op, "err", err)
			c.close(closeUnknownError, "internal error")
			return nil
		case s != nil:
			return s
		}
		_ = c.ws.SetReadDeadline(time.Now().Add(g.identifyTimeout)) // INVALID_SESSION: await IDENTIFY
	}
}

func (g *Gateway) readLoop(c *conn, s *session) {
	bye := false
	defer func() { s.post(detach{c, bye}) }()
	timeout := g.heartbeat * 3 / 2
	_ = c.ws.SetReadDeadline(time.Now().Add(timeout))
	var awareness tokenBucket
	for {
		f, ok, clean := g.read(c, closeSessionTimeout)
		if !ok {
			bye = clean
			return
		}
		switch f.Op {
		case opHeartbeat:
			_ = c.ws.SetReadDeadline(time.Now().Add(timeout))
			c.sendOp(opHeartbeatAck, nil)
			g.touch(s)
		case opPresenceUpdate, opVoiceState:
			s.post(f)
		case opDocAwareness:
			var p docAwareness
			if err := decode(f.D, &p); err != nil {
				c.close(closeDecodeError, "decode error")
				return
			}
			// Dropped here, before post: a flood must not fill s.in and
			// kill the session.
			if len(p.Envelope) <= maxAwarenessEnvelope && awareness.take(g.now()) {
				s.post(p)
			}
		case opIdentify, opResume:
			c.close(closeAlreadyAuthed, "already authenticated")
			return
		default:
			c.close(closeUnknownOpcode, "unknown opcode")
			return
		}
	}
}

// docAwareness is the op 5 payload (§6).
type docAwareness struct {
	ChannelID string `json:"channelId"`
	PageID    string `json:"pageId"`
	Envelope  string `json:"envelope"`
}

// tokenBucket holds awarenessPerSecond tokens and refills at that rate.
// Only the read loop of one connection uses it. The zero value is full:
// the elapsed time since the zero time.Time saturates the refill.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

func (b *tokenBucket) take(now time.Time) bool {
	b.tokens = min(awarenessPerSecond, b.tokens+now.Sub(b.last).Seconds()*awarenessPerSecond)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// touch refreshes every per-session TTL; heartbeats are the liveness signal.
func (g *Gateway) touch(s *session) {
	ctx := context.Background()
	_, err := g.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, k := range []string{kSession(s.id), kEvents(s.id), kPresence(s.user.ID), kUserSessions(s.user.ID)} {
			p.Expire(ctx, k, sessionTTL)
		}
		// SET, not EXPIRE: when another session of this device ends, it
		// deletes the key, and this session must claim it again.
		claimDeviceScript.Eval(ctx, p, []string{kSession(s.id), kDeviceOnline(s.deviceID)}, s.id, sessionTTL.Milliseconds())
		return nil
	})
	if err != nil {
		slog.Warn("heartbeat refresh failed", "session", s.id, "err", err)
	}
}

type closeErr struct {
	code int
	msg  string
}

func (e closeErr) Error() string { return fmt.Sprintf("close %d: %s", e.code, e.msg) }

var (
	errAuthFailed    = closeErr{closeAuthFailed, "authentication failed"}
	errUnsupported   = closeErr{closeUnsupported, "client unsupported"}
	errDeviceRevoked = closeErr{closeDeviceRevoked, "device unknown or revoked"}
)

// checkClient is IDENTIFY check 2 (§12.13): the e2ee/1 capability and a
// clientVersion at or above minClientVersion.
func (g *Gateway) checkClient(capabilities []string, clientVersion string) error {
	v, ok := parseSemver(clientVersion)
	if !slices.Contains(capabilities, capabilityE2EE) || !ok || v.less(g.minClientVersion) {
		return errUnsupported
	}
	return nil
}

// checkDevice is IDENTIFY check 3 (§12.13): the devices row exists, belongs
// to the user and is not revoked. A pending device (linking) is allowed.
func (g *Gateway) checkDevice(ctx context.Context, userID, deviceID string) (deviceRow, error) {
	if _, err := uuid.Parse(deviceID); err != nil {
		return deviceRow{}, errDeviceRevoked
	}
	d, err := g.device(ctx, deviceID)
	if errors.Is(err, errNoDevice) {
		return d, errDeviceRevoked
	}
	if err != nil {
		return d, fmt.Errorf("device lookup: %w", err)
	}
	if d.UserID != userID || d.Status == "revoked" {
		return d, errDeviceRevoked
	}
	return d, nil
}

// auth resolves a bearer token to a user via Takusen GET /api/v1/users/@me
// (no token introspection endpoint).
func (g *Gateway) auth(ctx context.Context, token string) (User, error) {
	var u User
	if token == "" {
		return u, errAuthFailed
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, g.takusenURL+"/api/v1/users/@me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := g.http.Do(req)
	if err != nil {
		return u, fmt.Errorf("takusen /users/@me: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return u, errAuthFailed
	}
	if err := json.NewDecoder(res.Body).Decode(&u); err != nil || u.ID == "" {
		return u, fmt.Errorf("takusen /users/@me: bad body: %v", err)
	}
	return u, nil
}

func decode(raw json.RawMessage, v any) error {
	if err := json.Unmarshal(raw, v); err != nil {
		return closeErr{closeDecodeError, "decode error"}
	}
	return nil
}

func randomToken() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (g *Gateway) identify(c *conn, raw json.RawMessage) (*session, error) {
	var p struct {
		Token         string
		DeviceID      string
		Capabilities  []string
		ClientVersion string
		DeviceProof   *deviceProof
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	ctx := context.Background()
	user, err := g.auth(ctx, p.Token)
	if err != nil {
		return nil, err
	}
	if err := g.checkClient(p.Capabilities, p.ClientVersion); err != nil {
		return nil, err
	}
	d, err := g.checkDevice(ctx, user.ID, p.DeviceID)
	if err != nil {
		return nil, err
	}
	if err := g.checkDeviceProof(ctx, d, p.DeviceID, "", p.Token, p.DeviceProof); err != nil {
		return nil, err
	}
	data, err := g.load(ctx, user.ID, "")
	if err != nil {
		return nil, fmt.Errorf("load ready: %w", err)
	}
	s := g.newSession(uuid.NewString(), user, p.DeviceID, c)
	if _, err := g.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, kSession(s.id), "userId", user.ID, "deviceId", s.deviceID, "seq", 0, "owner", s.owner)
		p.Expire(ctx, kSession(s.id), sessionTTL)
		p.SAdd(ctx, kUserSessions(user.ID), s.id)
		p.Expire(ctx, kUserSessions(user.ID), sessionTTL)
		p.Set(ctx, kDeviceOnline(s.deviceID), s.id, sessionTTL)
		return nil
	}); err != nil {
		return nil, err
	}
	s.seed(data)
	announce := s.restorePresence(ctx)
	ready := map[string]any{
		"v": 1, "sessionId": s.id, "deviceId": s.deviceID, "user": user,
		"guilds":          s.clientGuilds(ctx, data.Guilds),
		"privateChannels": nonNil(data.DMs),
		"presences":       g.presences(ctx, keys(s.dmPartners)),
		"readStates":      s.visibleReadStates(data.ReadStates),
	}
	g.addSession(s)
	go s.run(func() bool {
		if !s.recheckDevice() {
			return false
		}
		s.dispatch("READY", ready)
		if announce {
			s.publishPresence()
		}
		return true
	})
	return s, nil
}

func (g *Gateway) resume(c *conn, raw json.RawMessage) (*session, error) {
	var p struct {
		Token       string
		SessionID   string
		Seq         int64
		DeviceID    string
		DeviceProof *deviceProof
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	ctx := context.Background()
	user, err := g.auth(ctx, p.Token)
	if err != nil {
		return nil, err
	}
	// RESUME has no capabilities; the session passed check 2 at IDENTIFY.
	// The device check runs again: a revoked device must not RESUME.
	d, err := g.checkDevice(ctx, user.ID, p.DeviceID)
	if err != nil {
		return nil, err
	}
	if err := g.checkDeviceProof(ctx, d, p.DeviceID, p.SessionID, p.Token, p.DeviceProof); err != nil {
		return nil, err
	}
	owner := randomToken()
	res, err := takeoverScript.Run(ctx, g.rdb, []string{kSession(p.SessionID), kEvents(p.SessionID)}, user.ID, p.DeviceID, owner).Slice()
	if errors.Is(err, redis.Nil) {
		c.sendOp(opInvalidSession, false)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	seq, _ := strconv.ParseInt(fmt.Sprint(res[0]), 10, 64)
	frames, _ := res[1].([]any)
	if p.Seq > seq {
		return nil, closeErr{closeInvalidSeq, "invalid seq"}
	}
	replay, ok := framesAfter(frames, p.Seq, seq)
	if !ok {
		g.rdb.Del(ctx, kSession(p.SessionID), kEvents(p.SessionID))
		c.sendOp(opInvalidSession, false)
		return nil, nil
	}
	data, err := g.load(ctx, user.ID, "")
	if err != nil {
		return nil, fmt.Errorf("load resume state: %w", err)
	}
	s := g.newSession(p.SessionID, user, p.DeviceID, c)
	s.owner = owner
	s.seed(data)
	g.rdb.SAdd(ctx, kUserSessions(user.ID), s.id)
	g.rdb.Set(ctx, kDeviceOnline(s.deviceID), s.id, sessionTTL)
	announce := s.restorePresence(ctx)
	s.restoreVoice(ctx)
	for _, f := range replay {
		c.send(f)
	}
	// ponytail: an event that reaches the old owner after the takeover and
	// this node before addSession is dropped for this session.
	g.addSession(s)
	go s.run(func() bool {
		if !s.recheckDevice() {
			return false
		}
		s.dispatch("RESUMED", struct{}{})
		if announce {
			s.publishPresence()
		}
		return true
	})
	return s, nil
}

// framesAfter picks the buffered frames with s > after, oldest first.
// frames is newest-first as stored. ok=false means the buffer no longer
// reaches back far enough (a gap), so the client must re-IDENTIFY.
func framesAfter(frames []any, after, latest int64) (out [][]byte, ok bool) {
	for i := len(frames) - 1; i >= 0; i-- {
		str, _ := frames[i].(string)
		var h struct{ S int64 }
		if json.Unmarshal([]byte(str), &h) != nil || h.S <= after {
			continue
		}
		out = append(out, []byte(str))
	}
	if after == latest {
		return nil, true
	}
	if len(out) == 0 {
		return nil, false
	}
	var first struct{ S int64 }
	_ = json.Unmarshal(out[0], &first)
	return out, first.S == after+1
}
