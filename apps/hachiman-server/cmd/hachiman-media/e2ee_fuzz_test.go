// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

// Native Go fuzz targets for the voice E2EE ops (contract §8, §12.10.1).
// Run one target for 30 s:
//
//	go test ./cmd/hachiman-media -run '^$' -fuzz '^FuzzE2EEOps$' -fuzztime 30s
//
// Without -fuzz, `go test` runs each target on its seed corpus only.

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"hachiman/server/pkg/voicetoken"
)

// FuzzDecodeB64url: never panics; what decodes is strict §12.2 base64url
// (encodes back to the same text).
func FuzzDecodeB64url(f *testing.F) {
	for _, s := range []string{"", "AQID", "-_8", "AQ==", "AR", "A", "AQ\nID", "+/8", "ab cd"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		b, err := decodeB64url(s)
		if err != nil {
			return
		}
		if got := encodeB64url(b); got != s {
			t.Fatalf("%q decoded to %x, which encodes as %q", s, b, got)
		}
	})
}

// FuzzParseCommitHeader: never panics; an accepted header has the constant
// fields, a minimal length prefix, and re-encodes to the same prefix bytes.
func FuzzParseCommitHeader(f *testing.F) {
	gid := newVoiceGroupID()
	seed, _ := decodeB64url(fakeCommit(gid, 7, 3))
	f.Add(seed)
	f.Add(append([]byte{0, 1, 0, 1, 0x40, 64}, bytes.Repeat([]byte{9}, 64+13)...))
	f.Add([]byte{0, 1, 0, 1, 0x80, 0, 0x40, 0})
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, b []byte) {
		h, err := parseCommitHeader(b)
		if err != nil {
			return
		}
		want := []byte{0, 1, 0, 1}
		switch n := len(h.groupID); {
		case n < 64:
			want = append(want, byte(n))
		case n < 16384:
			want = binary.BigEndian.AppendUint16(want, uint16(n)|0x4000)
		default:
			want = binary.BigEndian.AppendUint32(want, uint32(n)|0x80000000)
		}
		want = append(want, h.groupID...)
		want = binary.BigEndian.AppendUint64(want, h.epoch)
		want = append(want, 1)
		want = binary.BigEndian.AppendUint32(want, h.leafIndex)
		if !bytes.HasPrefix(b, want) {
			t.Fatalf("header %+v does not re-encode to the input prefix\n in  %x\n out %x", h, b, want)
		}
	})
}

// MARK: - The E2EE state machine

// hijacker is an http.ResponseWriter whose Hijack returns one end of a
// net.Pipe, so a real *websocket.Conn exists without a listening socket.
type hijacker struct {
	conn net.Conn
	h    http.Header
}

func (h *hijacker) Header() http.Header         { return h.h }
func (h *hijacker) Write(b []byte) (int, error) { return len(b), nil }
func (h *hijacker) WriteHeader(int)             {}
func (h *hijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return h.conn, bufio.NewReadWriter(bufio.NewReader(h.conn), bufio.NewWriter(h.conn)), nil
}

func pipeWS(t *testing.T) *websocket.Conn {
	server, client := net.Pipe()
	go func() { _, _ = io.Copy(io.Discard, client) }() // the handshake reply and close frames
	req, _ := http.NewRequest(http.MethodGet, "http://media/voice", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", base64.StdEncoding.EncodeToString(make([]byte, 16)))
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	ws, err := up.Upgrade(&hijacker{conn: server, h: http.Header{}}, req, nil)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	return ws
}

type fuzzRoom struct {
	t     *testing.T
	srv   *voiceServer
	conns []*voiceConn // index = session number; nil = never joined
	// lastPrepare is the highest transitionId in an e2ee_prepare_transition per conn.
	lastPrepare map[*voiceConn]int64
}

const fuzzRoomID = "room"

func (fr *fuzzRoom) join(k int) {
	sid := fmt.Sprintf("s%d", k)
	c := &voiceConn{srv: fr.srv, ws: pipeWS(fr.t), out: make(chan []byte, sendQueueLen), done: make(chan struct{})}
	c.claims = &voicetoken.Claims{SessionID: sid, UserID: fmt.Sprintf("u%d", k%3), DeviceID: fmt.Sprintf("d%d", k), ChannelID: fuzzRoomID}
	fr.srv.mu.Lock()
	old := fr.srv.conns[sid]
	fr.srv.conns[sid] = c
	fr.srv.mu.Unlock()
	if old != nil {
		old.close(closeReplaced, "replaced")
	}
	fr.srv.e2ee.join(c, encodeB64url([]byte("kp-"+sid)))
	for len(fr.conns) <= k {
		fr.conns = append(fr.conns, nil)
	}
	fr.conns[k] = c
}

func (fr *fuzzRoom) conn(k int) *voiceConn {
	if len(fr.conns) == 0 {
		return nil
	}
	return fr.conns[k%len(fr.conns)]
}

// snapshot reads what an op needs from the room under the lock.
func (fr *fuzzRoom) snapshot(c *voiceConn) (groupID []byte, epoch uint64, leaf uint32, pending, departed []string, last *e2eeTransition) {
	e := fr.srv.e2ee
	e.mu.Lock()
	defer e.mu.Unlock()
	r := e.rooms[fuzzRoomID]
	if r == nil {
		return nil, 0, 0, nil, nil, nil
	}
	groupID = r.groupID
	if r.epoch != nil {
		epoch = *r.epoch
	}
	if p := r.parts[c.claims.SessionID]; p != nil && p.leaf != nil {
		leaf = *p.leaf
	}
	for _, p := range r.parts {
		if p.pending() {
			pending = append(pending, p.sessionID)
		}
	}
	for _, d := range r.departed {
		if d.removedIn == 0 {
			departed = append(departed, d.sessionID)
		}
	}
	if n := len(r.transitions); n > 0 {
		last = r.transitions[n-1]
	}
	return
}

func pick(ids []string, mask byte) []string {
	out := []string{}
	for i, id := range ids {
		if i < 8 && mask&(1<<i) != 0 {
			out = append(out, id)
		}
	}
	return out
}

func (fr *fuzzRoom) op(code, a, b byte, raw []byte) {
	c := fr.conn(int(a))
	switch code % 10 {
	case 0, 1:
		fr.join(int(a % 6))
	case 2:
		if c != nil {
			c.close(websocket.CloseNormalClosure, "")
		}
	case 3:
		if c != nil {
			fr.srv.e2ee.handle(c, "e2ee_ready", json.RawMessage(`{"transitionId":null,"epoch":0,"leafIndex":0}`))
		}
	case 4:
		if c == nil {
			return
		}
		gid, epoch, leaf, pending, departed, _ := fr.snapshot(c)
		if b&0x80 != 0 {
			epoch += uint64(b & 3) // a stale or future epoch
		}
		added, removed := pick(pending, b), pick(departed, b>>4)
		d := map[string]any{"epoch": epoch, "commit": fakeCommit(gid, epoch, leaf), "added": added, "removed": removed}
		if len(added) > 0 {
			d["welcome"] = testWelcome
		}
		msg, _ := json.Marshal(d)
		fr.srv.e2ee.handle(c, "e2ee_commit", msg)
	case 5:
		if c != nil {
			_, epoch, _, _, _, _ := fr.snapshot(c)
			msg, _ := json.Marshal(map[string]any{"epoch": epoch, "ratchetTree": testTree})
			fr.srv.e2ee.handle(c, "e2ee_ratchet_tree", msg)
		}
	case 6, 7:
		if c == nil {
			return
		}
		_, epoch, _, _, _, last := fr.snapshot(c)
		var id int64
		if last != nil {
			id = last.id - int64(b&1)
		}
		var msg []byte
		if code%10 == 6 {
			msg, _ = json.Marshal(map[string]any{"transitionId": id, "epoch": epoch, "leafIndex": uint32(b >> 1 & 7)})
			fr.srv.e2ee.handle(c, "e2ee_ready", msg)
		} else {
			msg, _ = json.Marshal(map[string]any{"transitionId": id, "reason": "fuzz", "committerLeaf": 0})
			fr.srv.e2ee.handle(c, "e2ee_invalid", msg)
		}
	case 8:
		if c != nil {
			ops := []string{"e2ee_commit", "e2ee_ratchet_tree", "e2ee_ready", "e2ee_invalid", "e2ee_other"}
			fr.srv.e2ee.handle(c, ops[int(b)%len(ops)], json.RawMessage(raw))
		}
	case 9:
		e := fr.srv.e2ee
		e.mu.Lock()
		r := e.rooms[fuzzRoomID]
		var t *e2eeTransition
		if r != nil && len(r.transitions) > 0 {
			t = r.transitions[int(a)%len(r.transitions)]
		}
		e.mu.Unlock()
		if t != nil {
			e.onTimer(r, t, b&1 == 1)
		}
	}
}

// drain reads every queued frame and checks the frame-level invariants.
func (fr *fuzzRoom) drain() {
	for _, c := range fr.conns {
		if c == nil {
			continue
		}
		for {
			select {
			case raw := <-c.out:
				var f struct {
					Op string          `json:"op"`
					D  json.RawMessage `json:"d"`
				}
				if err := json.Unmarshal(raw, &f); err != nil {
					fr.t.Fatalf("server sent bad JSON: %s", raw)
				}
				switch f.Op {
				case "e2ee_roster":
					var r rosterMsg
					if err := json.Unmarshal(f.D, &r); err != nil {
						fr.t.Fatalf("roster: %v", err)
					}
					leaves := map[uint32]string{}
					for _, m := range r.Members {
						if m.LeafIndex == nil {
							continue
						}
						if other, dup := leaves[*m.LeafIndex]; dup {
							fr.t.Fatalf("roster gives leaf %d to %s and %s: %s", *m.LeafIndex, other, m.SessionID, f.D)
						}
						leaves[*m.LeafIndex] = m.SessionID
					}
				case "e2ee_prepare_transition":
					var d struct {
						TransitionID int64 `json:"transitionId"`
					}
					_ = json.Unmarshal(f.D, &d)
					if d.TransitionID <= fr.lastPrepare[c] {
						fr.t.Fatalf("prepare %d after %d on one session", d.TransitionID, fr.lastPrepare[c])
					}
					fr.lastPrepare[c] = d.TransitionID
				}
			default:
				goto next
			}
		}
	next:
	}
}

// check verifies the room-state invariants under the lock.
func (fr *fuzzRoom) check() {
	e := fr.srv.e2ee
	e.mu.Lock()
	defer e.mu.Unlock()
	r := e.rooms[fuzzRoomID]
	if r == nil {
		return
	}
	if len(r.parts) == 0 {
		fr.t.Fatal("a room with no participants is kept")
	}
	leaves := map[uint32]*e2eeParticipant{}
	for sid, p := range r.parts {
		if p.sessionID != sid {
			fr.t.Fatalf("participant %s is filed under %s", p.sessionID, sid)
		}
		if p.leaf != nil {
			if q := leaves[*p.leaf]; q != nil {
				fr.t.Fatalf("sessions %s and %s hold leaf %d", q.sessionID, p.sessionID, *p.leaf)
			}
			leaves[*p.leaf] = p
		}
	}
	if r.committer != nil && r.parts[r.committer.sessionID] != r.committer {
		fr.t.Fatalf("committer %s is not a participant", r.committer.sessionID)
	}
	// No committer is legal only while the joiners of a transition wait for
	// their Welcome (nobody holds a leaf yet). The ready timer of that
	// transition then resolves the room, so a transition must exist.
	if r.committer == nil && (r.epoch == nil || len(leaves) > 0 || len(r.transitions) == 0) {
		fr.t.Fatalf("no committer: epoch %v, %d leaves, %d transitions", r.epoch, len(leaves), len(r.transitions))
	}
	var prev *e2eeTransition
	for _, t := range r.transitions {
		if t.id > r.lastTransition {
			fr.t.Fatalf("transition %d above lastTransition %d", t.id, r.lastTransition)
		}
		if prev != nil && (t.id <= prev.id || t.epoch <= prev.epoch) {
			fr.t.Fatalf("transitions out of order: %d/%d after %d/%d", t.id, t.epoch, prev.id, prev.epoch)
		}
		prev = t
	}
	if prev != nil && (r.epoch == nil || *r.epoch != prev.epoch) {
		fr.t.Fatalf("room epoch %v, latest transition epoch %d", r.epoch, prev.epoch)
	}
	inFlight := 0
	for _, t := range r.transitions {
		if !t.executed {
			inFlight++
		}
	}
	if inFlight > 1 {
		fr.t.Fatalf("%d transitions are not executed; commits must wait for the first", inFlight)
	}
	for _, d := range r.departed {
		if d.removedIn != 0 && r.transition(d.removedIn) == nil {
			fr.t.Fatalf("departed %s is removed by transition %d, which is gone", d.sessionID, d.removedIn)
		}
	}
}

// FuzzE2EEOps drives the room state machine with op sequences from the input:
// joins, leaves, creator ready, commits (valid, stale, with adds and
// removes), trees, readies, invalid reports, raw JSON, and the timers. After
// every op it checks the room invariants and the frames that went out.
func FuzzE2EEOps(f *testing.F) {
	f.Add([]byte{0, 0, 0, 0, 1, 0, 3, 0, 0, 4, 0, 1, 5, 0, 0, 6, 0, 0, 6, 1, 0})
	f.Add([]byte{0, 0, 0, 0, 1, 0, 0, 2, 0, 3, 0, 0, 4, 0, 3, 5, 0, 0, 9, 0, 1, 2, 1, 0, 4, 0, 0x10})
	f.Add([]byte{0, 0, 0, 3, 0, 0, 8, 0, 0, '{', '"', 'e', '"', ':', '1', '}'})
	f.Add([]byte{0, 0, 0, 0, 1, 0, 3, 0, 0, 4, 0, 1, 4, 0, 0x81, 7, 1, 0, 7, 0, 0, 9, 0, 0, 9, 0, 1})

	oldE, oldW, oldR := e2eeExecuteTimeout, e2eeCommitTimeout, e2eeReadyTimeout
	e2eeExecuteTimeout, e2eeCommitTimeout, e2eeReadyTimeout = time.Hour, time.Hour, time.Hour // ops fire timers
	defer func() { e2eeExecuteTimeout, e2eeCommitTimeout, e2eeReadyTimeout = oldE, oldW, oldR }()

	f.Fuzz(func(t *testing.T, in []byte) {
		if len(in) > 600 {
			return
		}
		srv := newVoiceServer(nil, nil, log.New(io.Discard, "", 0))
		fr := &fuzzRoom{t: t, srv: srv, lastPrepare: map[*voiceConn]int64{}}
		defer func() {
			for _, c := range fr.conns {
				if c != nil {
					c.close(websocket.CloseNormalClosure, "")
				}
			}
			if n := len(srv.e2ee.rooms); n != 0 {
				t.Fatalf("%d rooms left after every session closed", n)
			}
		}()
		for len(in) >= 3 {
			code, a, b := in[0], in[1], in[2]
			in = in[3:]
			var raw []byte
			if code%10 == 8 {
				// The rest of the input up to a 0xff byte is the raw frame body.
				n := bytes.IndexByte(in, 0xff)
				if n < 0 {
					n = len(in)
				}
				raw, in = in[:n], in[min(n+1, len(in)):]
			}
			fr.op(code, a, b, raw)
			fr.drain()
			fr.check()
		}
	})
}
