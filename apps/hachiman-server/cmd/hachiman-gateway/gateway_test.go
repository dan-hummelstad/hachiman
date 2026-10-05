// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/permissions"
	"hachiman/server/pkg/voicetoken"
)

const (
	gid = "g1"
	me  = "u1"

	// Device ids are UUIDs, as in the devices table.
	devA       = "0a000000-0000-4000-8000-00000000000a"
	devB       = "0b000000-0000-4000-8000-00000000000b"
	devPending = "0c000000-0000-4000-8000-00000000000c"
	devRevoked = "0d000000-0000-4000-8000-00000000000d"
	devOther   = "0e000000-0000-4000-8000-00000000000e" // belongs to u2
)

func ptr(s string) *string { return &s }

// fixture: guild g1 with a public text channel, a text channel hidden from
// @everyone but open to role "mod", and a voice channel.
func fixture() *readyData {
	hidden := []permissions.Overwrite{
		{ID: gid, Type: "role", Deny: permissions.ViewChannel},
		{ID: "mod", Type: "role", Allow: permissions.ViewChannel},
	}
	return &readyData{Guilds: []*GuildFull{{
		Guild: Guild{ID: gid, Name: "Guild", Banner: ptr("0b6f2c1e-8a4d-4f3b-9c2e-5d7a1b3c4e5f/banner.png"), OwnerID: "owner", Region: ptr("eu"), CreatedAt: "2026-01-01T00:00:00Z"},
		Roles: []Role{{ID: gid, GuildID: gid, Name: "@everyone", Permissions: permissions.DefaultEveryone}, {ID: "mod", GuildID: gid, Name: "mod"}},
		Channels: []Channel{
			{ID: "text", GuildID: ptr(gid), Type: "text", Name: ptr("general"), PermissionOverwrites: []permissions.Overwrite{}},
			{ID: "secret", GuildID: ptr(gid), Type: "text", Name: ptr("mods"), PermissionOverwrites: hidden},
			{ID: "voice", GuildID: ptr(gid), Type: "voice", Name: ptr("Lounge"), PermissionOverwrites: []permissions.Overwrite{}},
		},
		Members: []Member{{GuildID: gid, User: User{ID: me, Username: "me"}, Roles: []string{}, JoinedAt: "2026-01-01T00:00:00Z"}},
	}}}
}

type harness struct {
	t   *testing.T
	mr  *miniredis.Miniredis
	rdb *redis.Client
	g   *Gateway
	url string

	devMu   sync.Mutex
	devices map[string]deviceRow
}

func (h *harness) setDevice(id string, row deviceRow) {
	h.devMu.Lock()
	h.devices[id] = row
	h.devMu.Unlock()
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() }) // runs before miniredis stops: late session timers fail fast
	takusen := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/users/@me" || r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(User{ID: me, Username: "me"})
	}))
	t.Cleanup(takusen.Close)
	signer, err := voicetoken.NewSigner(filepath.Join(t.TempDir(), "voice.key"))
	if err != nil {
		t.Fatal(err)
	}
	g := newGateway(rdb, takusen.URL, nil, signer)
	g.heartbeat = time.Second
	g.offlineGrace = 300 * time.Millisecond
	g.load = func(ctx context.Context, userID, onlyGuild string) (*readyData, error) { return fixture(), nil }
	h := &harness{t: t, mr: mr, rdb: rdb, g: g, devices: map[string]deviceRow{
		devA:       {UserID: me, Status: "active", SignatureKey: testDevicePub(devA)},
		devB:       {UserID: me, Status: "active", SignatureKey: testDevicePub(devB)},
		devPending: {UserID: me, Status: "pending", SignatureKey: testDevicePub(devPending)},
		devRevoked: {UserID: me, Status: "revoked", SignatureKey: testDevicePub(devRevoked)},
		devOther:   {UserID: "u2", Status: "active", SignatureKey: testDevicePub(devOther)},
	}}
	g.device = func(ctx context.Context, id string) (deviceRow, error) {
		h.devMu.Lock()
		defer h.devMu.Unlock()
		d, ok := h.devices[id]
		if !ok {
			return d, errNoDevice
		}
		return d, nil
	}
	g.nodeURL = func(ctx context.Context, nodeID string) (string, error) {
		if nodeID == "node-a" {
			return "ws://media-a/voice", nil
		}
		return "", errNodeGone
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go g.runBus(ctx)
	<-g.busReady
	srv := httptest.NewServer(g.routes())
	t.Cleanup(srv.Close)
	h.url = "ws" + strings.TrimPrefix(srv.URL, "http") + "/gateway"
	return h
}

type outFrame struct {
	Op int             `json:"op"`
	S  int64           `json:"s"`
	T  string          `json:"t"`
	D  json.RawMessage `json:"d"`
}

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func (h *harness) dial() *client {
	h.t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial(h.url, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { ws.Close() })
	c := &client{h.t, ws}
	if f := c.next(); f.Op != opHello {
		h.t.Fatalf("first frame op %d, want HELLO", f.Op)
	}
	return c
}

func (c *client) send(op int, d any) {
	c.t.Helper()
	if err := c.ws.WriteJSON(map[string]any{"op": op, "d": d}); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) next() outFrame {
	c.t.Helper()
	_ = c.ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	var f outFrame
	if err := c.ws.ReadJSON(&f); err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return f
}

// expect reads dispatches until t arrives, skipping our own presence echoes.
func (c *client) expect(t string) outFrame {
	c.t.Helper()
	for {
		f := c.next()
		if f.Op == opDispatch && f.T == t {
			return f
		}
		if f.T != "PRESENCE_UPDATE" && f.T != "VOICE_STATE_UPDATE" {
			c.t.Fatalf("got op=%d t=%s (%s), want %s", f.Op, f.T, f.D, t)
		}
	}
}

func (c *client) expectClose(code int) {
	c.t.Helper()
	_ = c.ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, _, err := c.ws.ReadMessage()
		if err == nil {
			continue
		}
		if !websocket.IsCloseError(err, code) {
			c.t.Fatalf("got %v, want close %d", err, code)
		}
		return
	}
}

// testDeviceKey is the MLS signature key of a test device: fixed per id.
func testDeviceKey(deviceID string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("test-device:" + deviceID))
	return ed25519.NewKeyFromSeed(seed[:])
}

func testDevicePub(deviceID string) []byte {
	return testDeviceKey(deviceID).Public().(ed25519.PublicKey)
}

// proofFor is a fresh deviceProof of deviceID (§12.13), signed now.
func proofFor(deviceID, sessionID, token string) map[string]any {
	return proofAt(testDeviceKey(deviceID), deviceID, sessionID, token, time.Now().UnixMilli())
}

func proofAt(key ed25519.PrivateKey, deviceID, sessionID, token string, ts int64) map[string]any {
	var n [16]byte
	_, _ = rand.Read(n[:])
	nonce := base64.RawURLEncoding.EncodeToString(n[:])
	sig := ed25519.Sign(key, identifyProofMessage(deviceID, sessionID, ts, nonce, token))
	return map[string]any{"ts": ts, "nonce": nonce, "sig": base64.RawURLEncoding.EncodeToString(sig)}
}

// identifyAs is a valid IDENTIFY payload for deviceID (§12.13).
func identifyAs(deviceID string) map[string]any {
	return map[string]any{"token": "good", "deviceId": deviceID, "capabilities": []string{"e2ee/1"}, "clientVersion": "1.0.0", "deviceProof": proofFor(deviceID, "", "good")}
}

// resumeAs adds the deviceProof of the payload's token, sessionId and deviceId.
func resumeAs(p map[string]any) map[string]any {
	device, _ := p["deviceId"].(string)
	sid, _ := p["sessionId"].(string)
	token, _ := p["token"].(string)
	p["deviceProof"] = proofFor(device, sid, token)
	return p
}

func (c *client) identify() string { return c.identifyDevice(devA) }

func (c *client) identifyDevice(deviceID string) string {
	c.t.Helper()
	c.send(opIdentify, identifyAs(deviceID))
	f := c.expect("READY")
	var r struct{ SessionID, DeviceID string }
	_ = json.Unmarshal(f.D, &r)
	if r.DeviceID != deviceID {
		c.t.Fatalf("READY deviceId %q, want %q", r.DeviceID, deviceID)
	}
	return r.SessionID
}

func (h *harness) pub(channel, t string, d any, channelID string) {
	h.t.Helper()
	b, _ := json.Marshal(envelope{T: t, D: mustJSON(d), ChannelID: channelID})
	if err := h.rdb.Publish(context.Background(), channel, b).Err(); err != nil {
		h.t.Fatal(err)
	}
}

func TestIdentifyReadyHidesInvisibleChannels(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.send(opIdentify, identifyAs(devA))
	f := c.expect("READY")
	if f.S != 1 {
		t.Errorf("READY seq %d, want 1", f.S)
	}
	var r struct {
		V         int
		SessionID string
		Guilds    []GuildFull
	}
	if err := json.Unmarshal(f.D, &r); err != nil || r.V != 1 || r.SessionID == "" || len(r.Guilds) != 1 {
		t.Fatalf("bad READY %s (%v)", f.D, err)
	}
	var names []string
	for _, ch := range r.Guilds[0].Channels {
		names = append(names, ch.ID)
	}
	if strings.Join(names, ",") != "text,voice" {
		t.Errorf("visible channels %v, want text,voice", names)
	}
	if b := r.Guilds[0].Banner; b == nil || *b != "0b6f2c1e-8a4d-4f3b-9c2e-5d7a1b3c4e5f/banner.png" {
		t.Errorf("READY guild banner %v, want the file key", b)
	}
	if got := h.mr.HGet(kSession(r.SessionID), "userId"); got != me {
		t.Errorf("session hash userId %q", got)
	}
	if got := h.mr.HGet(kSession(r.SessionID), "deviceId"); got != devA {
		t.Errorf("session hash deviceId %q", got)
	}
	if st, _ := h.mr.Get(kPresence(me)); st != "online" {
		t.Errorf("presence %q, want online", st)
	}
	c.send(opHeartbeat, 1)
	if f := c.next(); f.Op != opHeartbeatAck {
		// our own PRESENCE_UPDATE may land first
		if f := c.next(); f.Op != opHeartbeatAck {
			t.Errorf("no HEARTBEAT_ACK")
		}
	}
}

func TestHandshakeCloseCodes(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.send(opIdentify, map[string]string{"token": "bad"})
	c.expectClose(closeAuthFailed)

	c = h.dial()
	c.send(opPresenceUpdate, map[string]string{"status": "idle"})
	c.expectClose(closeNotAuthenticated)

	c = h.dial()
	_ = c.ws.WriteMessage(websocket.TextMessage, []byte("{nope"))
	c.expectClose(closeDecodeError)

	c = h.dial()
	c.identify()
	c.send(opIdentify, identifyAs(devA))
	c.expectClose(closeAlreadyAuthed)

	c = h.dial()
	c.identify()
	c.send(42, nil)
	c.expectClose(closeUnknownOpcode)
}

func TestHeartbeatTimeout(t *testing.T) {
	h := newHarness(t)
	h.g.heartbeat = 100 * time.Millisecond
	c := h.dial()
	c.identify()
	c.expectClose(closeSessionTimeout)
}

func TestViewChannelFilteringAndVisibilityChanges(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.identify()
	msg := func(ch, content string) map[string]string {
		return map[string]string{"channelId": ch, "content": content}
	}

	h.pub("guild:"+gid, "MESSAGE_CREATE", msg("secret", "hidden"), "secret")
	h.pub("guild:"+gid, "MESSAGE_CREATE", msg("text", "visible"), "text")
	if f := c.expect("MESSAGE_CREATE"); !strings.Contains(string(f.D), "visible") {
		t.Fatalf("got %s, want the visible message only", f.D)
	}

	// Gaining the mod role reveals #secret.
	h.pub("guild:"+gid, "GUILD_MEMBER_UPDATE", Member{GuildID: gid, User: User{ID: me}, Roles: []string{"mod"}}, "")
	c.expect("GUILD_MEMBER_UPDATE")
	if f := c.expect("CHANNEL_CREATE"); !strings.Contains(string(f.D), `"id":"secret"`) {
		t.Fatalf("CHANNEL_CREATE %s, want secret", f.D)
	}
	h.pub("guild:"+gid, "MESSAGE_CREATE", msg("secret", "now-visible"), "secret")
	c.expect("MESSAGE_CREATE")

	// An overwrite hiding #text turns CHANNEL_UPDATE into CHANNEL_DELETE.
	hide := Channel{ID: "text", GuildID: ptr(gid), Type: "text", PermissionOverwrites: []permissions.Overwrite{{ID: me, Type: "member", Deny: permissions.ViewChannel}}}
	h.pub("guild:"+gid, "CHANNEL_UPDATE", hide, "text")
	c.expect("CHANNEL_DELETE")
	// And un-hiding turns it into CHANNEL_CREATE.
	hide.PermissionOverwrites = []permissions.Overwrite{}
	h.pub("guild:"+gid, "CHANNEL_UPDATE", hide, "text")
	c.expect("CHANNEL_CREATE")

	// Being removed from the guild unsubscribes the session.
	h.pub("user:"+me, "GUILD_DELETE", map[string]string{"id": gid}, "")
	c.expect("GUILD_DELETE")
	h.pub("guild:"+gid, "MESSAGE_CREATE", msg("text", "after-leave"), "text")
	h.pub("user:"+me, "MESSAGE_CREATE", msg("dm", "marker"), "")
	if f := c.expect("MESSAGE_CREATE"); !strings.Contains(string(f.D), "marker") {
		t.Fatalf("got %s after leaving the guild", f.D)
	}

	// GUILD_CREATE to the user resubscribes (reloaded via g.load).
	h.pub("user:"+me, "GUILD_CREATE", map[string]string{"id": gid}, "")
	c.expect("GUILD_CREATE")
	h.pub("guild:"+gid, "MESSAGE_CREATE", msg("text", "back"), "text")
	c.expect("MESSAGE_CREATE")
}

func TestResumeReplaysBufferedEvents(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	sid := c.identify()
	c.ws.Close() // abnormal close: session stays resumable

	h.pub("guild:"+gid, "MESSAGE_CREATE", map[string]string{"content": "while-away"}, "text")
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(strings.Join(lrange(h, kEvents(sid)), ""), "while-away") {
		if time.Now().After(deadline) {
			t.Fatal("detached session did not buffer the event")
		}
		time.Sleep(10 * time.Millisecond)
	}

	c2 := h.dial()
	c2.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sid, "seq": 1, "deviceId": devA}))
	var last int64 = 1
	sawMsg := false
	for {
		f := c2.next()
		if f.Op != opDispatch {
			t.Fatalf("op %d during replay", f.Op)
		}
		if f.S != last+1 {
			t.Fatalf("seq %d after %d", f.S, last)
		}
		last = f.S
		sawMsg = sawMsg || f.T == "MESSAGE_CREATE"
		if f.T == "RESUMED" {
			break
		}
	}
	if !sawMsg {
		t.Fatal("buffered MESSAGE_CREATE was not replayed")
	}
	// The resumed session keeps receiving live events.
	h.pub("guild:"+gid, "MESSAGE_CREATE", map[string]string{"content": "live"}, "text")
	if f := c2.expect("MESSAGE_CREATE"); f.S != last+1 {
		t.Errorf("live seq %d, want %d", f.S, last+1)
	}
}

func TestResumeInvalidSession(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": "nope", "seq": 3, "deviceId": devA}))
	if f := c.next(); f.Op != opInvalidSession || string(f.D) != "false" {
		t.Fatalf("got op=%d d=%s, want INVALID_SESSION(false)", f.Op, f.D)
	}
	c.identify() // same socket may IDENTIFY afterwards

	// Seq ahead of the server ⇒ 4007.
	c3 := h.dial()
	s3 := c3.identify()
	c3.ws.Close()
	c4 := h.dial()
	c4.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": s3, "seq": 999, "deviceId": devA}))
	c4.expectClose(closeInvalidSeq)
}

func TestSessionEndsAfterGrace(t *testing.T) {
	h := newHarness(t)
	sub := h.rdb.Subscribe(context.Background(), "guild:"+gid)
	defer sub.Close()
	if _, err := sub.Receive(context.Background()); err != nil {
		t.Fatal(err)
	}
	c := h.dial()
	sid := c.identify()
	c.ws.Close()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m := <-sub.Channel():
			if strings.Contains(m.Payload, `"offline"`) {
				if h.mr.Exists(kSession(sid)) || h.mr.Exists(kPresence(me)) {
					t.Error("session/presence keys survived the grace period")
				}
				return
			}
		case <-deadline:
			t.Fatal("no offline PRESENCE_UPDATE after grace")
		}
	}
}

func TestCleanCloseEndsImmediately(t *testing.T) {
	h := newHarness(t)
	h.g.offlineGrace = time.Hour
	c := h.dial()
	sid := c.identify()
	_ = c.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"))
	deadline := time.Now().Add(2 * time.Second)
	for h.mr.Exists(kSession(sid)) {
		if time.Now().After(deadline) {
			t.Fatal("1000 close did not end the session")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestVoiceJoinToggleLeave(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.mr.Set(kVoiceRoom("voice"), "node-a") // pre-placed: no Takusen gRPC needed
	kicks := h.rdb.Subscribe(ctx, "media:node-a")
	defer kicks.Close()
	if _, err := kicks.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	c := h.dial()
	sid := c.identify()

	join := map[string]any{"guildId": gid, "channelId": "voice", "selfMute": false, "selfDeaf": false}
	c.send(opVoiceState, join)
	f := c.expect("VOICE_SERVER_UPDATE")
	var vsu struct {
		Endpoint, Token, ChannelID string
		IceServers                 []map[string]any
	}
	_ = json.Unmarshal(f.D, &vsu)
	if vsu.Endpoint != "ws://media-a/voice" || vsu.Token == "" || vsu.ChannelID != "voice" || len(vsu.IceServers) != 1 {
		t.Fatalf("bad VOICE_SERVER_UPDATE %s", f.D)
	}
	v, err := voicetoken.NewVerifier(h.g.signer.PublicKeyHex(), "node-a")
	if err != nil {
		t.Fatal(err)
	}
	if cl, err := v.Verify(vsu.Token); err != nil || cl.SessionID != sid || cl.ChannelID != "voice" || cl.DeviceID != devA {
		t.Fatalf("token verify: %v %+v", err, cl)
	}
	if got, _ := h.mr.Get(kVoiceUser(me)); got != gid {
		t.Errorf("voice_user = %q", got)
	}

	// Mute toggle: state update only, no new media credentials.
	join["selfMute"] = true
	c.send(opVoiceState, join)
	c.send(opVoiceState, map[string]any{"guildId": gid, "channelId": nil})
	select {
	case m := <-kicks.Channel():
		var k map[string]string
		_ = json.Unmarshal([]byte(m.Payload), &k)
		if k["op"] != "kick" || k["sessionId"] != sid || k["channelId"] != "voice" {
			t.Errorf("kick payload %s", m.Payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no media kick on leave")
	}
	for {
		f := c.next()
		if f.T == "VOICE_SERVER_UPDATE" {
			t.Fatal("mute toggle re-issued VOICE_SERVER_UPDATE")
		}
		if f.T == "VOICE_STATE_UPDATE" && strings.Contains(string(f.D), `"channelId":null`) {
			break
		}
	}
	if h.mr.Exists(kVoiceRoom("voice")) || h.mr.Exists(kVoiceUser(me)) || h.mr.HGet(kVoice(gid), me) != "" {
		t.Error("voice keys survived leave")
	}
}

// VOICE_DISCONNECTED from media (§8) ends the call of that token only: a stale
// jti is ignored, the current one leaves voice, and clients never see the event.
func TestVoiceDisconnectedFromMedia(t *testing.T) {
	h := newHarness(t)
	h.mr.Set(kVoiceRoom("voice"), "node-a")
	c := h.dial()
	sid := c.identify()
	c.send(opVoiceState, map[string]any{"guildId": gid, "channelId": "voice"})
	var vsu struct{ Token string }
	_ = json.Unmarshal(c.expect("VOICE_SERVER_UPDATE").D, &vsu)
	v, err := voicetoken.NewVerifier(h.g.signer.PublicKeyHex(), "node-a")
	if err != nil {
		t.Fatal(err)
	}
	cl, err := v.Verify(vsu.Token)
	if err != nil {
		t.Fatal(err)
	}

	h.pub("device:"+devA, "VOICE_DISCONNECTED", map[string]string{"sessionId": sid, "channelId": "voice", "jti": "stale"}, "")
	time.Sleep(100 * time.Millisecond)
	if h.mr.HGet(kVoice(gid), me) == "" {
		t.Fatal("a stale jti ended the call")
	}

	h.pub("device:"+devA, "VOICE_DISCONNECTED", map[string]string{"sessionId": sid, "channelId": "voice", "jti": cl.JTI}, "")
	for {
		f := c.next()
		if f.T == "VOICE_DISCONNECTED" {
			t.Fatal("internal event reached the client")
		}
		if f.T == "VOICE_STATE_UPDATE" && strings.Contains(string(f.D), `"channelId":null`) {
			break
		}
	}
	if h.mr.Exists(kVoiceUser(me)) || h.mr.HGet(kVoice(gid), me) != "" {
		t.Error("voice keys survived VOICE_DISCONNECTED")
	}
}

func TestVoiceRejectsHiddenAndNonVoiceChannels(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.identify()
	for _, ch := range []string{"text", "secret", "missing"} {
		c.send(opVoiceState, map[string]any{"guildId": gid, "channelId": ch})
	}
	c.send(opHeartbeat, nil)
	for {
		f := c.next()
		if f.Op == opHeartbeatAck {
			break
		}
		if f.T == "VOICE_SERVER_UPDATE" || f.T == "VOICE_STATE_UPDATE" {
			t.Fatalf("joined a non-joinable channel: %s", f.D)
		}
	}
}

func TestFramesAfter(t *testing.T) {
	frame := func(s int) any { return fmt.Sprintf(`{"op":0,"s":%d,"t":"X","d":{}}`, s) }
	newestFirst := []any{frame(5), frame(4), frame(3)}
	cases := []struct {
		after, latest int64
		want          int
		ok            bool
	}{
		{5, 5, 0, true},  // up to date
		{3, 5, 2, true},  // replay 4,5
		{2, 5, 3, true},  // replay 3,4,5
		{1, 5, 0, false}, // 2 was trimmed ⇒ gap
	}
	for _, c := range cases {
		out, ok := framesAfter(newestFirst, c.after, c.latest)
		if ok != c.ok || (ok && len(out) != c.want) {
			t.Errorf("after=%d: got %d frames ok=%v, want %d ok=%v", c.after, len(out), ok, c.want, c.ok)
		}
		if ok && len(out) > 0 && !strings.Contains(string(out[0]), fmt.Sprintf(`"s":%d`, c.after+1)) {
			t.Errorf("after=%d: first replayed frame %s", c.after, out[0])
		}
	}
}

func lrange(h *harness, key string) []string {
	v, _ := h.rdb.LRange(context.Background(), key, 0, -1).Result()
	return v
}

func TestUserUpdateAndMemberAvatarPassThrough(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.identify()

	h.pub("user:"+me, "USER_UPDATE", User{ID: me, Username: "me", Avatar: ptr("3f8e9a2b-1c4d-4e5f-8a6b-7c9d0e1f2a3b/avatar.png")}, "")
	if f := c.expect("USER_UPDATE"); !strings.Contains(string(f.D), `"avatar":"3f8e9a2b-1c4d-4e5f-8a6b-7c9d0e1f2a3b/avatar.png"`) {
		t.Fatalf("USER_UPDATE %s", f.D)
	}

	// Another member's avatar change must not touch my role set: holding "mod"
	// in their payload would otherwise reveal #secret to me.
	h.pub("guild:"+gid, "GUILD_MEMBER_UPDATE", Member{GuildID: gid, User: User{ID: "u2", Avatar: ptr("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/avatar.png")}, Roles: []string{"mod"}}, "")
	c.expect("GUILD_MEMBER_UPDATE")
	h.pub("guild:"+gid, "MESSAGE_CREATE", map[string]any{
		"channelId": "text", "content": "marker",
		"attachments": []map[string]any{{"id": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f", "key": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f/cat.png"}},
	}, "text")
	if f := c.expect("MESSAGE_CREATE"); !strings.Contains(string(f.D), `"key":"c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f/cat.png"`) {
		t.Fatalf("MESSAGE_CREATE lost attachments: %s", f.D)
	}
}
