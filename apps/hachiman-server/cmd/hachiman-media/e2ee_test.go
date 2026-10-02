// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"hachiman/server/pkg/voicetoken"
)

// The E2EE tests drive the voice WS without a PeerConnection: offers stay
// unanswered, so the negotiation timeouts are raised for them.
func e2eeTimers(t *testing.T, execute, commit, ready time.Duration) {
	t.Helper()
	oldA, oldC := answerTimeout, connectTimeout
	oldE, oldW, oldR := e2eeExecuteTimeout, e2eeCommitTimeout, e2eeReadyTimeout
	answerTimeout, connectTimeout = time.Minute, time.Minute
	e2eeExecuteTimeout, e2eeCommitTimeout, e2eeReadyTimeout = execute, commit, ready
	t.Cleanup(func() {
		answerTimeout, connectTimeout = oldA, oldC
		e2eeExecuteTimeout, e2eeCommitTimeout, e2eeReadyTimeout = oldE, oldW, oldR
	})
}

type rosterMsg struct {
	GroupID   string        `json:"groupId"`
	Epoch     *uint64       `json:"epoch"`
	Committer *string       `json:"committer"`
	Create    bool          `json:"create"`
	Members   []rosterEntry `json:"members"`
	Pending   []rosterEntry `json:"pending"`
	Departed  []rosterEntry `json:"departed"`
}

func (r rosterMsg) committer() string {
	if r.Committer == nil {
		return ""
	}
	return *r.Committer
}

func sids(es []rosterEntry) string {
	var out []string
	for _, e := range es {
		out = append(out, e.SessionID)
	}
	return strings.Join(out, ",")
}

// expectRoster skips frames until an e2ee_roster that matches pred. Another
// e2ee_* op on the way fails the test.
func (c *wsClient) expectRoster(pred func(rosterMsg) bool) rosterMsg {
	c.t.Helper()
	timeout := time.After(5 * time.Second)
	var last rosterMsg
	for {
		select {
		case f := <-c.frames:
			if !isE2EE(f.Op) {
				continue
			}
			if f.Op != "e2ee_roster" {
				c.t.Fatalf("waiting for e2ee_roster, got %q: %s", f.Op, f.D)
			}
			if err := json.Unmarshal(f.D, &last); err != nil {
				c.t.Fatal(err)
			}
			if pred(last) {
				return last
			}
		case err := <-c.closed:
			c.t.Fatalf("waiting for e2ee_roster: %v (last %+v)", err, last)
		case <-timeout:
			c.t.Fatalf("timed out waiting for e2ee_roster (last %+v)", last)
		}
	}
}

// quietE2EE asserts that no e2ee_* frame other than a roster arrives in d.
func (c *wsClient) quietE2EE(d time.Duration) {
	c.t.Helper()
	timeout := time.After(d)
	for {
		select {
		case f := <-c.frames:
			if isE2EE(f.Op) && f.Op != "e2ee_roster" {
				c.t.Fatalf("expected no e2ee op, got %q: %s", f.Op, f.D)
			}
		case err := <-c.closed:
			c.t.Fatalf("quietE2EE: %v", err)
		case <-timeout:
			return
		}
	}
}

func decode[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return v
}

// fakeCommit is an MLSMessage PublicMessage header (§12.10.1) and opaque
// bytes. Media reads only the header.
func fakeCommit(groupID []byte, epoch uint64, leaf uint32) string {
	b := []byte{0, 1, 0, 1, byte(len(groupID))}
	b = append(b, groupID...)
	b = binary.BigEndian.AppendUint64(b, epoch)
	b = append(b, 1)
	b = binary.BigEndian.AppendUint32(b, leaf)
	return encodeB64url(append(b, "opaque framed content"...))
}

const (
	testWelcome = "d2VsY29tZQ"
	testTree    = "cmF0Y2hldC10cmVl"
)

type member struct {
	c    *wsClient
	sid  string
	leaf uint32
}

type transitionMsg struct {
	TransitionID int64  `json:"transitionId"`
	Epoch        uint64 `json:"epoch"`
	Commit       string `json:"commit"`
	Welcome      string `json:"welcome"`
	RatchetTree  string `json:"ratchetTree"`
}

// group is a test room whose members follow the protocol.
type group struct {
	t       *testing.T
	h       *harness
	room    string
	gid     []byte
	epoch   uint64
	members []*member
}

func (h *harness) joinE2EE(sid, room string) *wsClient {
	h.t.Helper()
	c := h.dial(h.token(sid, "u-"+sid, room))
	c.next("ready")
	return c
}

// newGroup makes a room of n members: the first creates the group, then
// it adds each other member with one commit.
func newGroup(t *testing.T, h *harness, room string, n int) *group {
	t.Helper()
	a := h.joinE2EE(room+"-0", room)
	r := a.expectRoster(func(r rosterMsg) bool { return true })
	if !r.Create || r.committer() != room+"-0" || r.Epoch != nil {
		t.Fatalf("first roster = %+v, want create by %s with epoch null", r, room+"-0")
	}
	gid, err := decodeB64url(r.GroupID)
	if err != nil || len(gid) != groupIDLen || gid[0] != 1 || gid[1] != groupKindVoice || !bytes.Equal(gid[18:], []byte{0, 0, 0, 0}) {
		t.Fatalf("groupId %q = %x, %v", r.GroupID, gid, err)
	}
	a.send("e2ee_ready", map[string]any{"transitionId": nil, "epoch": 0, "leafIndex": 0})
	a.expectRoster(func(r rosterMsg) bool { return r.Epoch != nil && *r.Epoch == 0 })
	g := &group{t: t, h: h, room: room, gid: gid, members: []*member{{c: a, sid: room + "-0"}}}
	for i := 1; i < n; i++ {
		g.add(roomSID(room, i), uint32(i))
	}
	return g
}

func roomSID(room string, i int) string { return room + "-" + string(rune('0'+i)) }

// add joins sid and has the committer (members[0]) add it.
func (g *group) add(sid string, leaf uint32) *member {
	g.t.Helper()
	x := g.h.joinE2EE(sid, g.room)
	x.expectRoster(func(r rosterMsg) bool { return strings.Contains(sids(r.Pending), sid) })
	m := &member{c: x, sid: sid, leaf: leaf}
	tid := g.commitAdd(g.members[0], m)
	g.readyAll(tid, append(g.members, m))
	g.members = append(g.members, m)
	return m
}

// commitAdd sends a commit that adds joiner (after its key package reached
// committer) and returns the transition id that the members see.
func (g *group) commitAdd(committer, joiner *member) int64 {
	g.t.Helper()
	kp := decode[map[string]string](g.t, committer.c.next("e2ee_key_package"))
	if kp["sessionId"] != joiner.sid || kp["keyPackage"] != testKeyPackage || kp["deviceId"] != "dev-"+joiner.sid {
		g.t.Fatalf("key package = %v, want %s", kp, joiner.sid)
	}
	committer.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, committer.leaf), "welcome": testWelcome, "added": []string{joiner.sid}, "removed": []string{}})
	committer.c.send("e2ee_ratchet_tree", map[string]any{"epoch": g.epoch + 1, "ratchetTree": testTree})
	var tid int64
	for _, m := range g.members {
		p := decode[transitionMsg](g.t, m.c.next("e2ee_prepare_transition"))
		if p.Epoch != g.epoch+1 || p.Commit == "" {
			g.t.Fatalf("prepare = %+v", p)
		}
		tid = p.TransitionID
	}
	w := decode[transitionMsg](g.t, joiner.c.next("e2ee_welcome"))
	tr := decode[transitionMsg](g.t, joiner.c.next("e2ee_ratchet_tree"))
	if w.TransitionID != tid || w.Welcome != testWelcome || tr.RatchetTree != testTree || tr.Epoch != g.epoch+1 {
		g.t.Fatalf("welcome %+v tree %+v (transition %d)", w, tr, tid)
	}
	g.epoch++
	return tid
}

func (g *group) readyAll(tid int64, ms []*member) {
	g.t.Helper()
	for _, m := range ms {
		m.c.send("e2ee_ready", map[string]any{"transitionId": tid, "epoch": g.epoch, "leafIndex": m.leaf})
	}
	for _, m := range ms {
		ex := decode[transitionMsg](g.t, m.c.next("e2ee_execute_transition"))
		if ex.TransitionID != tid || ex.Epoch != g.epoch {
			g.t.Fatalf("execute = %+v, want %d/%d", ex, tid, g.epoch)
		}
	}
}

func TestE2EE_IdentifyChecks(t *testing.T) {
	e2eeTimers(t, time.Second, time.Second, time.Second)
	h := newHarness(t)
	for name, d := range map[string]map[string]any{
		"no e2ee":   {"token": h.token("s1", "u1", "r")},
		"version 2": {"token": h.token("s2", "u2", "r"), "e2ee": map[string]any{"version": 2, "keyPackage": testKeyPackage}},
	} {
		c := h.dial("")
		c.send("identify", d)
		if code := c.closeCode(); code != closeE2EERequired {
			t.Errorf("%s: close %d, want %d", name, code, closeE2EERequired)
		}
	}
	c := h.dial("")
	c.send("identify", map[string]any{"token": h.token("s3", "u3", "r"), "e2ee": map[string]any{"version": 1, "keyPackage": "a2V5==" /* padded */}})
	if code := c.closeCode(); code != closeE2EEProtocol {
		t.Errorf("bad key package: close %d, want %d", code, closeE2EEProtocol)
	}
	noDevice, _ := h.signer.Mint(voicetoken.Claims{SessionID: "s4", UserID: "u4", GuildID: "g", ChannelID: "r", MediaNodeID: testNode})
	if code := h.dial(noDevice).closeCode(); code != closeBadToken {
		t.Errorf("no deviceId: close %d, want %d", code, closeBadToken)
	}
}

func TestE2EE_JoinOrderCreateAndKeyPackage(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, time.Second)
	h := newHarness(t)
	a := h.joinE2EE("sA", "room")
	// ready was read by joinE2EE; then peers, e2ee_roster, offer.
	var ops []string
	for len(ops) < 3 {
		select {
		case f := <-a.frames:
			if f.Op != "candidate" {
				ops = append(ops, f.Op)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("frames %v", ops)
		}
	}
	if strings.Join(ops, ",") != "peers,e2ee_roster,offer" {
		t.Fatalf("join frames = %v, want peers,e2ee_roster,offer", ops)
	}

	// Before the creator's ready, a joiner's key package is not relayed.
	b := h.joinE2EE("sB", "room")
	r := b.expectRoster(func(rosterMsg) bool { return true })
	if !r.Create || r.committer() != "sA" || r.Epoch != nil || sids(r.Pending) != "sA,sB" || len(r.Members) != 0 {
		t.Fatalf("roster before create = %+v", r)
	}
	a.quietE2EE(200 * time.Millisecond)

	a.send("e2ee_ready", map[string]any{"transitionId": nil, "epoch": 0, "leafIndex": 0})
	r = b.expectRoster(func(r rosterMsg) bool { return r.Epoch != nil })
	if *r.Epoch != 0 || r.Create || sids(r.Members) != "sA" || *r.Members[0].LeafIndex != 0 || sids(r.Pending) != "sB" || r.Members[0].DeviceID != "dev-sA" {
		t.Fatalf("roster after create = %+v", r)
	}
	kp := decode[map[string]string](t, a.next("e2ee_key_package"))
	if kp["sessionId"] != "sB" || kp["userId"] != "u-sB" || kp["deviceId"] != "dev-sB" || kp["keyPackage"] != testKeyPackage {
		t.Fatalf("key package = %v", kp)
	}
	b.quietE2EE(100 * time.Millisecond) // not the committer: no key packages

	// A second creator ready is a protocol violation.
	b.send("e2ee_ready", map[string]any{"transitionId": nil, "epoch": 0, "leafIndex": 0})
	if code := b.closeCode(); code != closeE2EEProtocol {
		t.Fatalf("B close %d, want %d", code, closeE2EEProtocol)
	}
}

func TestE2EE_WelcomeTreeAndExecute(t *testing.T) {
	e2eeTimers(t, 300*time.Millisecond, time.Minute, 800*time.Millisecond)
	h := newHarness(t)
	g := newGroup(t, h, "r", 1)
	a := g.members[0]

	// Add B: candidate and speaking frames may come between commit and tree.
	b := &member{c: h.joinE2EE("sB", "r"), sid: "sB", leaf: 1}
	kp := decode[map[string]string](t, a.c.next("e2ee_key_package"))
	if kp["sessionId"] != "sB" {
		t.Fatalf("kp %v", kp)
	}
	a.c.send("e2ee_commit", map[string]any{"epoch": 0, "commit": fakeCommit(g.gid, 0, 0), "welcome": testWelcome, "added": []string{"sB"}, "removed": nil})
	a.c.send("candidate", map[string]any{"candidate": nil})
	a.c.send("speaking", map[string]any{"speaking": true})
	a.c.send("e2ee_ratchet_tree", map[string]any{"epoch": 1, "ratchetTree": testTree})
	p := decode[transitionMsg](t, a.c.next("e2ee_prepare_transition"))
	if p.Epoch != 1 || p.Commit != fakeCommit(g.gid, 0, 0) {
		t.Fatalf("prepare %+v", p)
	}
	w := decode[transitionMsg](t, b.c.next("e2ee_welcome"))
	tr := decode[transitionMsg](t, b.c.next("e2ee_ratchet_tree"))
	if w.TransitionID != p.TransitionID || w.Welcome != testWelcome || tr.TransitionID != p.TransitionID || tr.RatchetTree != testTree {
		t.Fatalf("welcome %+v tree %+v", w, tr)
	}
	r := a.c.expectRoster(func(r rosterMsg) bool { return *r.Epoch == 1 })
	if sids(r.Members) != "r-0,sB" || r.Members[1].LeafIndex != nil || len(r.Pending) != 0 {
		t.Fatalf("roster in transition = %+v", r)
	}
	g.epoch = 1
	g.readyAll(p.TransitionID, []*member{a, b})
	g.members = append(g.members, b)
	r = a.c.expectRoster(func(r rosterMsg) bool { return len(r.Members) == 2 && r.Members[1].LeafIndex != nil })
	if *r.Members[1].LeafIndex != 1 {
		t.Fatalf("roster after ready = %+v", r)
	}

	// Add C; C never sends e2ee_ready. Execute comes after the 3 s timer,
	// and C is closed with 4013 after the 10 s timer.
	c := &member{c: h.joinE2EE("sC", "r"), sid: "sC", leaf: 2}
	tid := g.commitAdd(a, c)
	for _, m := range []*member{a, b} {
		m.c.send("e2ee_ready", map[string]any{"transitionId": tid, "epoch": g.epoch, "leafIndex": m.leaf})
	}
	start := time.Now()
	for _, m := range []*member{a, b, c} {
		if ex := decode[transitionMsg](t, m.c.next("e2ee_execute_transition")); ex.TransitionID != tid {
			t.Fatalf("execute %+v", ex)
		}
	}
	if el := time.Since(start); el < 200*time.Millisecond {
		t.Fatalf("execute after %v, want the execute timeout", el)
	}
	if code := c.c.closeCode(); code != closeE2EEResync {
		t.Fatalf("C close %d, want %d", code, closeE2EEResync)
	}
	r = a.c.expectRoster(func(r rosterMsg) bool { return sids(r.Departed) == "sC" })
	if r.Departed[0].LeafIndex != nil || r.Departed[0].DeviceID != "dev-sC" || sids(r.Members) != "r-0,sB" {
		t.Fatalf("roster after C closed = %+v", r)
	}

	// After a commit with a Welcome, another e2ee op before the tree is 4014.
	d := h.joinE2EE("sD", "r")
	a.c.next("e2ee_key_package")
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": testWelcome, "added": []string{"sD"}, "removed": []string{"sC"}})
	a.c.send("e2ee_ready", map[string]any{"transitionId": tid + 1, "epoch": g.epoch + 1, "leafIndex": 0})
	if code := a.c.closeCode(); code != closeE2EEProtocol {
		t.Fatalf("A close %d, want %d", code, closeE2EEProtocol)
	}
	_ = d
}

func TestE2EE_ConcurrentCommits(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, 2*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 2)
	a, b := g.members[0], g.members[1]
	c := h.joinE2EE("sC", "r")
	a.c.next("e2ee_key_package")
	commitFrom := func(m *member) {
		m.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, m.leaf), "welcome": testWelcome, "added": []string{"sC"}, "removed": []string{}})
		m.c.send("e2ee_ratchet_tree", map[string]any{"epoch": g.epoch + 1, "ratchetTree": testTree})
	}
	go commitFrom(b)
	commitFrom(a)

	// Exactly one wins: both members get its prepare, and the loser also
	// gets e2ee_commit_rejected.
	rejected := map[*member]bool{}
	prepared := map[*member]string{}
	handle := func(m *member, f frame) {
		switch f.Op {
		case "e2ee_commit_rejected":
			rj := decode[map[string]uint64](t, f.D)
			if rj["epoch"] != g.epoch || rj["currentEpoch"] != g.epoch+1 || rejected[m] {
				t.Fatalf("rejected %v", rj)
			}
			rejected[m] = true
		case "e2ee_prepare_transition":
			prepared[m] = decode[transitionMsg](t, f.D).Commit
		case "e2ee_roster", "candidate", "offer", "peers":
		default:
			t.Fatalf("unexpected %q: %s", f.Op, f.D)
		}
	}
	deadline := time.After(5 * time.Second)
	for len(prepared) < 2 || len(rejected) < 1 {
		select {
		case f := <-a.c.frames:
			handle(a, f)
		case f := <-b.c.frames:
			handle(b, f)
		case <-deadline:
			t.Fatalf("prepared %v rejected %v", prepared, rejected)
		}
	}
	if prepared[a] != prepared[b] {
		t.Fatal("members got different winning commits")
	}
	for m := range rejected {
		if prepared[m] == fakeCommit(g.gid, g.epoch, m.leaf) {
			t.Fatal("the rejected member's commit won")
		}
	}
	a.c.quietE2EE(200 * time.Millisecond)
	b.c.quietE2EE(10 * time.Millisecond)
	c.next("e2ee_welcome")
	c.next("e2ee_ratchet_tree")
}

func TestE2EE_BadCommitHeaders(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, time.Second)
	h := newHarness(t)
	for i, tc := range []struct {
		name   string
		commit func(g *group) string
	}{
		{"malformed", func(*group) string { return encodeB64url([]byte{0, 1, 0, 1, 0x40}) }},
		{"wire format", func(g *group) string {
			b, _ := decodeB64url(fakeCommit(g.gid, 0, 0))
			b[3] = 2
			return encodeB64url(b)
		}},
		{"non-minimal length", func(g *group) string {
			b, _ := decodeB64url(fakeCommit(g.gid, 0, 0))
			return encodeB64url(append([]byte{0, 1, 0, 1, 0x40, 22}, b[5:]...))
		}},
		{"other group", func(g *group) string {
			other := append([]byte(nil), g.gid...)
			other[5] ^= 1
			return fakeCommit(other, 0, 0)
		}},
		{"false leaf", func(g *group) string { return fakeCommit(g.gid, 0, 7) }},
		{"epoch mismatch", func(g *group) string { return fakeCommit(g.gid, 3, 0) }},
		{"not base64url", func(*group) string { return "AAA=" }},
	} {
		g := newGroup(t, h, "bad"+string(rune('a'+i)), 2)
		g.members[0].c.send("e2ee_commit", map[string]any{"epoch": 1, "commit": tc.commit(g), "welcome": nil, "added": []string{}, "removed": []string{}})
		if code := g.members[0].c.closeCode(); code != closeE2EEProtocol {
			t.Errorf("%s: close %d, want %d", tc.name, code, closeE2EEProtocol)
		}
		// The other member stays and becomes the committer.
		r := g.members[1].c.expectRoster(func(r rosterMsg) bool { return r.committer() == g.members[1].sid })
		if sids(r.Departed) != g.members[0].sid {
			t.Errorf("%s: roster %+v", tc.name, r)
		}
	}
}

func TestE2EE_CommitterFailover(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, 2*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 2)
	a, b := g.members[0], g.members[1]
	e2eeCommitTimeout = 300 * time.Millisecond
	h.joinE2EE("sC", "r")
	a.c.next("e2ee_key_package")
	start := time.Now()
	r := b.c.expectRoster(func(r rosterMsg) bool { return r.committer() == b.sid })
	if el := time.Since(start); el < 250*time.Millisecond {
		t.Fatalf("failover after %v", el)
	}
	if sids(r.Pending) != "sC" {
		t.Fatalf("roster %+v", r)
	}
	if kp := decode[map[string]string](t, b.c.next("e2ee_key_package")); kp["sessionId"] != "sC" {
		t.Fatalf("kp to new committer = %v", kp)
	}
	// The new committer's commit is accepted.
	b.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, b.leaf), "welcome": testWelcome, "added": []string{"sC"}, "removed": []string{}})
	b.c.send("e2ee_ratchet_tree", map[string]any{"epoch": g.epoch + 1, "ratchetTree": testTree})
	a.c.next("e2ee_prepare_transition")
}

func TestE2EE_KickMovesToDeparted(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, 2*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 3)
	a, b := g.members[0], g.members[1]
	h.srv.kick(b.sid, "r")
	if code := b.c.closeCode(); code != closeKicked {
		t.Fatalf("close %d", code)
	}
	r := a.c.expectRoster(func(r rosterMsg) bool { return len(r.Departed) == 1 })
	if r.Departed[0].SessionID != b.sid || r.Departed[0].LeafIndex == nil || *r.Departed[0].LeafIndex != 1 || sids(r.Members) != "r-0,r-2" {
		t.Fatalf("roster after kick = %+v", r)
	}
	// Removing a session that is not departed is rejected, not accepted.
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": nil, "added": []string{}, "removed": []string{"r-2"}})
	if rj := decode[map[string]uint64](t, a.c.next("e2ee_commit_rejected")); rj["currentEpoch"] != g.epoch {
		t.Fatalf("rejected %v", rj)
	}
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": nil, "added": []string{}, "removed": []string{b.sid}})
	tid := decode[transitionMsg](t, a.c.next("e2ee_prepare_transition")).TransitionID
	g.members[2].c.next("e2ee_prepare_transition")
	g.epoch++
	g.readyAll(tid, []*member{a, g.members[2]})

	// A replacement (4011) also moves the old leaf to departed.
	c := g.members[2]
	h.dial(h.token(c.sid, "u-"+c.sid, "r")).next("ready")
	if code := c.c.closeCode(); code != closeReplaced {
		t.Fatalf("close %d", code)
	}
	r = a.c.expectRoster(func(r rosterMsg) bool { return len(r.Departed) == 1 && len(r.Pending) == 1 })
	if r.Departed[0].SessionID != c.sid || *r.Departed[0].LeafIndex != 2 || r.Pending[0].SessionID != c.sid {
		t.Fatalf("roster after replace = %+v", r)
	}
}

func TestE2EE_BadCommitEvictsCommitter(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, 2*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 3)
	a, b, c := g.members[0], g.members[1], g.members[2]
	h.joinE2EE("sD", "r")
	a.c.next("e2ee_key_package")
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": testWelcome, "added": []string{"sD"}, "removed": []string{}})
	a.c.send("e2ee_ratchet_tree", map[string]any{"epoch": g.epoch + 1, "ratchetTree": testTree})
	tid := decode[transitionMsg](t, b.c.next("e2ee_prepare_transition")).TransitionID
	c.c.next("e2ee_prepare_transition")
	for _, m := range []*member{b, c} {
		m.c.send("e2ee_invalid", map[string]any{"transitionId": tid, "reason": "bad signature", "committerLeaf": 0})
	}
	if code := a.c.closeCode(); code != closeE2EEProtocol {
		t.Fatalf("committer close %d, want %d", code, closeE2EEProtocol)
	}
	r := b.c.expectRoster(func(r rosterMsg) bool { return r.committer() == b.sid })
	if *r.Epoch != g.epoch || sids(r.Members) != "r-1,r-2" || sids(r.Pending) != "sD" || sids(r.Departed) != "r-0" {
		t.Fatalf("roster after eviction = %+v (epoch want %d)", r, g.epoch)
	}
	if kp := decode[map[string]string](t, b.c.next("e2ee_key_package")); kp["sessionId"] != "sD" {
		t.Fatalf("kp %v", kp)
	}
}

func TestE2EE_SingleInvalidResyncsOnlyThatMember(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, 2*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 3)
	a, b, c := g.members[0], g.members[1], g.members[2]
	d := &member{c: h.joinE2EE("sD", "r"), sid: "sD", leaf: 3}
	a.c.next("e2ee_key_package")
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": testWelcome, "added": []string{"sD"}, "removed": []string{}})
	a.c.send("e2ee_ratchet_tree", map[string]any{"epoch": g.epoch + 1, "ratchetTree": testTree})
	tid := decode[transitionMsg](t, b.c.next("e2ee_prepare_transition")).TransitionID
	b.c.send("e2ee_invalid", map[string]any{"transitionId": tid, "reason": "decrypt", "committerLeaf": 0})
	d.c.next("e2ee_welcome")
	d.c.next("e2ee_ratchet_tree")
	for _, m := range []*member{a, c, d} {
		m.c.send("e2ee_ready", map[string]any{"transitionId": tid, "epoch": g.epoch + 1, "leafIndex": m.leaf})
	}
	c.c.next("e2ee_prepare_transition")
	if ex := decode[transitionMsg](t, c.c.next("e2ee_execute_transition")); ex.TransitionID != tid {
		t.Fatalf("execute %+v", ex)
	}
	r := c.c.expectRoster(func(r rosterMsg) bool { return sids(r.Departed) == "r-1" })
	if r.committer() != "r-0" {
		t.Fatalf("roster %+v", r)
	}
	if code := b.c.closeCode(); code != closeE2EEResync {
		t.Fatalf("B close %d, want %d", code, closeE2EEResync)
	}
	// A stays connected and keeps the committer role.
	a.c.next("e2ee_prepare_transition")
	a.c.next("e2ee_execute_transition")
	a.c.quietE2EE(100 * time.Millisecond)
}

func TestE2EE_ReadLimit(t *testing.T) {
	e2eeTimers(t, time.Second, time.Minute, time.Second)
	h := newHarness(t)
	a := h.joinE2EE("sA", "room")
	a.peers() // own join
	a.offer() // before B joins: else B's peers frame can come first
	b := h.joinE2EE("sB", "room")
	a.peers() // B joined; the renegotiation waits for A's answer
	pad := strings.Repeat("x", 900<<10)
	b.send("speaking", map[string]any{"speaking": true, "pad": pad})
	if sp := decode[map[string]any](t, a.next("speaking")); sp["userId"] != "u-sB" {
		t.Fatalf("speaking %v", sp)
	}
	big := `{"op":"speaking","d":{"pad":"` + strings.Repeat("x", 1<<20) + `"}}`
	_ = b.ws.WriteMessage(websocket.TextMessage, []byte(big))
	if code := b.closeCode(); code != websocket.CloseMessageTooBig {
		t.Fatalf("close %d, want %d", code, websocket.CloseMessageTooBig)
	}
}

func TestE2EE_NoTreeNoExecute(t *testing.T) {
	e2eeTimers(t, 200*time.Millisecond, time.Minute, 800*time.Millisecond)
	h := newHarness(t)
	g := newGroup(t, h, "r", 2)
	a, b := g.members[0], g.members[1]
	d := h.joinE2EE("sD", "r")
	a.c.next("e2ee_key_package")
	// A commits an Add with a Welcome and never sends the tree.
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": testWelcome, "added": []string{"sD"}, "removed": []string{}})
	tid := decode[transitionMsg](t, b.c.next("e2ee_prepare_transition")).TransitionID
	b.c.send("e2ee_ready", map[string]any{"transitionId": tid, "epoch": g.epoch + 1, "leafIndex": b.leaf})
	// No execute at the execute timeout; at the ready timeout the room goes
	// back to the old epoch and the committer is evicted.
	start := time.Now()
	r := b.c.expectRoster(func(r rosterMsg) bool { return r.committer() == b.sid })
	if el := time.Since(start); el < 500*time.Millisecond {
		t.Fatalf("eviction after %v, want the ready timeout", el)
	}
	if *r.Epoch != g.epoch || sids(r.Pending) != "sD" || sids(r.Departed) != a.sid {
		t.Fatalf("roster after eviction = %+v (epoch want %d)", r, g.epoch)
	}
	if code := a.c.closeCode(); code != closeE2EEProtocol {
		t.Fatalf("committer close %d, want %d", code, closeE2EEProtocol)
	}
	if kp := decode[map[string]string](t, b.c.next("e2ee_key_package")); kp["sessionId"] != "sD" {
		t.Fatalf("kp %v", kp)
	}
	d.quietE2EE(50 * time.Millisecond)
}

func TestE2EE_LateTreeExecutes(t *testing.T) {
	e2eeTimers(t, 100*time.Millisecond, time.Minute, 2*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 2)
	a, b := g.members[0], g.members[1]
	d := h.joinE2EE("sD", "r")
	a.c.next("e2ee_key_package")
	a.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, 0), "welcome": testWelcome, "added": []string{"sD"}, "removed": []string{}})
	tid := decode[transitionMsg](t, b.c.next("e2ee_prepare_transition")).TransitionID
	a.c.next("e2ee_prepare_transition")
	b.c.quietE2EE(300 * time.Millisecond) // past the execute timeout: no execute without the tree
	a.c.send("e2ee_ratchet_tree", map[string]any{"epoch": g.epoch + 1, "ratchetTree": testTree})
	d.next("e2ee_welcome")
	d.next("e2ee_ratchet_tree")
	for _, c := range []*wsClient{a.c, b.c, d} {
		if ex := decode[transitionMsg](t, c.next("e2ee_execute_transition")); ex.TransitionID != tid {
			t.Fatalf("execute %+v", ex)
		}
	}
}

func TestE2EE_InvalidAfterExecuteKeepsEpoch(t *testing.T) {
	e2eeTimers(t, 200*time.Millisecond, time.Minute, 5*time.Second)
	h := newHarness(t)
	g := newGroup(t, h, "r", 3)
	a, b, c := g.members[0], g.members[1], g.members[2]
	d := &member{c: h.joinE2EE("sD", "r"), sid: "sD", leaf: 3}
	tid := g.commitAdd(a, d)
	for _, m := range []*member{a, d} {
		m.c.send("e2ee_ready", map[string]any{"transitionId": tid, "epoch": g.epoch, "leafIndex": m.leaf})
	}
	// B and C are slow: the execute timeout executes the transition.
	for _, m := range []*member{a, b, c, d} {
		m.c.next("e2ee_execute_transition")
	}
	for _, m := range []*member{b, c} {
		m.c.send("e2ee_invalid", map[string]any{"transitionId": tid, "reason": "bad signature", "committerLeaf": 0})
	}
	if code := a.c.closeCode(); code != closeE2EEProtocol {
		t.Fatalf("committer close %d, want %d", code, closeE2EEProtocol)
	}
	for _, m := range []*member{b, c} {
		if code := m.c.closeCode(); code != closeE2EEResync {
			t.Fatalf("%s close %d, want %d", m.sid, code, closeE2EEResync)
		}
	}
	// D executed the new epoch: the room keeps it.
	r := d.c.expectRoster(func(r rosterMsg) bool { return r.committer() == d.sid && len(r.Departed) == 3 })
	if *r.Epoch != g.epoch || sids(r.Members) != "sD" || len(r.Pending) != 0 {
		t.Fatalf("roster after eviction = %+v (epoch want %d)", r, g.epoch)
	}
	d.c.send("e2ee_commit", map[string]any{"epoch": g.epoch, "commit": fakeCommit(g.gid, g.epoch, d.leaf), "welcome": nil, "added": []string{}, "removed": []string{a.sid, b.sid, c.sid}})
	if p := decode[transitionMsg](t, d.c.next("e2ee_prepare_transition")); p.Epoch != g.epoch+1 {
		t.Fatalf("prepare %+v", p)
	}
}

func TestE2EE_StaleCreatorResyncs(t *testing.T) {
	e2eeTimers(t, time.Second, 300*time.Millisecond, time.Second)
	h := newHarness(t)
	a := h.joinE2EE("sA", "room")
	b := h.joinE2EE("sB", "room")
	b.expectRoster(func(r rosterMsg) bool { return r.Create && r.committer() == "sB" })
	b.send("e2ee_ready", map[string]any{"transitionId": nil, "epoch": 0, "leafIndex": 0})
	b.expectRoster(func(r rosterMsg) bool { return r.Epoch != nil })
	// A's createGroup finished after the failover.
	a.send("e2ee_ready", map[string]any{"transitionId": nil, "epoch": 0, "leafIndex": 0})
	if code := a.closeCode(); code != closeE2EEResync {
		t.Fatalf("A close %d, want %d", code, closeE2EEResync)
	}
}
