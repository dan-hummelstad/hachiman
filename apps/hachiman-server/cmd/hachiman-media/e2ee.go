// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"bytes"
	"encoding/json"
	"sort"
	"sync"
	"time"
)

// Voice E2EE relay and ordering (contract §8, §12.10.1). The media node has
// no MLS library. It signs nothing and proposes nothing: it keeps the room
// roster, relays key packages, Welcomes and ratchet trees, accepts the first
// commit per epoch, and closes sessions that break the protocol.
//
// Locking: one mutex (e2eeState.mu) guards every room. Frames are queued
// with the non-blocking voiceConn.send while it is held. Socket closes are
// collected in e2eeEffects and run after the unlock, because voiceConn.close
// calls back into leave.

// Close codes, contract §8.
const (
	closeE2EERequired = 4012
	closeE2EEResync   = 4013
	closeE2EEProtocol = 4014
)

// vars so tests can shorten them
var (
	e2eeExecuteTimeout = 3 * time.Second  // prepare → execute without every e2ee_ready
	e2eeCommitTimeout  = 5 * time.Second  // committer has work, no commit → next committer
	e2eeReadyTimeout   = 10 * time.Second // no e2ee_ready for a transition → 4013
)

type e2eeState struct {
	srv   *voiceServer
	mu    sync.Mutex
	rooms map[string]*e2eeRoom // room id (channel id) -> state
}

type e2eeRoom struct {
	id         string
	groupID    []byte
	groupIDB64 string
	epoch      *uint64 // nil until the creator's e2ee_ready(transitionId null)

	parts     map[string]*e2eeParticipant // session id -> live participant
	departed  []*e2eeDeparted
	committer *e2eeParticipant
	seq       uint64 // join order counter

	transitions    []*e2eeTransition // accepted, not yet resolved; oldest first
	lastTransition int64

	workTimer *time.Timer
	dirty     bool // roster changed; settle broadcasts it
}

type e2eeParticipant struct {
	conn                        *voiceConn
	sessionID, userID, deviceID string
	keyPackage                  string
	seq                         uint64  // join order; the creator is the lowest seq
	leaf                        *uint32 // from e2ee_ready
	addedIn                     int64   // the transition that adds this joiner (0 = pending)
	acked                       int64   // highest transitionId in an e2ee_ready
	kpSentTo                    *e2eeParticipant
	demoted                     bool      // lost the committer role (5 s failover)
	lostCreate                  bool      // lost the create role (5 s failover)
	expectTree                  *treeWait // set by e2ee_commit with a welcome
}

func (p *e2eeParticipant) pending() bool { return p.leaf == nil && p.addedIn == 0 }

type treeWait struct {
	epoch uint64
	t     *e2eeTransition // nil when the commit was rejected
}

// e2eeDeparted is a leaf that a commit must remove. leaf is nil for a joiner
// that left before it reported its leaf: the committer finds it by device id.
type e2eeDeparted struct {
	sessionID, userID, deviceID string
	leaf                        *uint32
	addedIn                     int64 // the leaf exists only while this transition holds
	removedIn                   int64 // the accepted commit that removes it (0 = none yet)
}

type e2eeTransition struct {
	id            int64
	epoch         uint64 // the new epoch
	committer     *e2eeParticipant
	committerLeaf uint32
	commit        string
	welcome       string // "" = no Add
	tree          string // "" until the committer's e2ee_ratchet_tree
	added         []*e2eeParticipant
	expected      map[*e2eeParticipant]bool // every member of the new epoch
	invalid       map[*e2eeParticipant]bool
	prevLeaves    map[*e2eeParticipant]*uint32
	executed      bool
	execDue       bool // the 3 s deadline passed before the tree arrived
	execTimer     *time.Timer
	readyTimer    *time.Timer
}

type e2eeClose struct {
	c      *voiceConn
	code   int
	reason string
}

type e2eeEffects []e2eeClose

func (fx *e2eeEffects) run() {
	for _, e := range *fx {
		e.c.close(e.code, e.reason)
	}
}

func newE2EEState(srv *voiceServer) *e2eeState {
	return &e2eeState{srv: srv, rooms: map[string]*e2eeRoom{}}
}

// locked runs fn under the lock, then closes what fn collected.
func (e *e2eeState) locked(fn func(fx *e2eeEffects)) {
	var fx e2eeEffects
	e.mu.Lock()
	fn(&fx)
	e.mu.Unlock()
	fx.run()
}

// MARK: - Join and leave

// join adds the session as a pending joiner and broadcasts the roster. The
// caller has sent ready and peers, so the joiner sees e2ee_roster third.
func (e *e2eeState) join(c *voiceConn, keyPackage string) {
	e.locked(func(fx *e2eeEffects) {
		select {
		case <-c.done:
			return // closed while joining: leave already ran
		default:
		}
		r := e.rooms[c.claims.ChannelID]
		if r == nil {
			id := newVoiceGroupID()
			r = &e2eeRoom{id: c.claims.ChannelID, groupID: id, groupIDB64: encodeB64url(id), parts: map[string]*e2eeParticipant{}}
			e.rooms[r.id] = r
		}
		if old := r.parts[c.claims.SessionID]; old != nil {
			e.leaveLocked(r, old) // same session again (4011): the old leaf departs
		}
		r.seq++
		r.parts[c.claims.SessionID] = &e2eeParticipant{
			conn: c, sessionID: c.claims.SessionID, userID: c.claims.UserID, deviceID: c.claims.DeviceID,
			keyPackage: keyPackage, seq: r.seq,
		}
		r.dirty = true
		e.settle(r, fx)
	})
}

// leave runs on every close (kick 4010, replace 4011, errors, disconnect).
func (e *e2eeState) leave(c *voiceConn) {
	e.locked(func(fx *e2eeEffects) {
		r, p := e.lookup(c)
		if p == nil {
			return
		}
		e.leaveLocked(r, p)
		e.settle(r, fx)
	})
}

func (e *e2eeState) lookup(c *voiceConn) (*e2eeRoom, *e2eeParticipant) {
	if c.claims == nil {
		return nil, nil
	}
	r := e.rooms[c.claims.ChannelID]
	if r == nil {
		return nil, nil
	}
	if p := r.parts[c.claims.SessionID]; p != nil && p.conn == c {
		return r, p
	}
	return nil, nil
}

// leaveLocked removes p from the room state. A participant with a leaf (or
// one that a commit added) moves to departed, so the next commit removes it.
func (e *e2eeState) leaveLocked(r *e2eeRoom, p *e2eeParticipant) {
	delete(r.parts, p.sessionID)
	if !p.pending() {
		d := &e2eeDeparted{sessionID: p.sessionID, userID: p.userID, deviceID: p.deviceID, leaf: p.leaf}
		if p.leaf == nil {
			d.addedIn = p.addedIn
		}
		r.departed = append(r.departed, d)
	}
	for _, t := range r.transitions {
		delete(t.expected, p)
		delete(t.invalid, p)
	}
	r.dirty = true
}

// drop takes p out of the room now and closes its socket after the unlock.
func (e *e2eeState) drop(r *e2eeRoom, p *e2eeParticipant, fx *e2eeEffects, code int, reason string) {
	e.srv.logger.Printf("session %s: e2ee close %d: %s", p.sessionID, code, reason)
	e.leaveLocked(r, p)
	*fx = append(*fx, e2eeClose{p.conn, code, reason})
}

// MARK: - Client ops

// handle dispatches one client e2ee_* frame.
func (e *e2eeState) handle(c *voiceConn, op string, raw json.RawMessage) {
	e.locked(func(fx *e2eeEffects) {
		r, p := e.lookup(c)
		if p == nil {
			return
		}
		violation := func(reason string) { e.drop(r, p, fx, closeE2EEProtocol, reason) }
		// After a commit with a Welcome, the next e2ee_* frame is the tree.
		if p.expectTree != nil && op != "e2ee_ratchet_tree" {
			violation("expected e2ee_ratchet_tree")
			e.settle(r, fx)
			return
		}
		var ok bool
		switch op {
		case "e2ee_commit":
			ok = e.onCommit(r, p, raw, fx)
		case "e2ee_ratchet_tree":
			ok = e.onTree(r, p, raw)
		case "e2ee_ready":
			ok = e.onReady(r, p, raw, fx)
		case "e2ee_invalid":
			ok = e.onInvalid(r, p, raw, fx)
		}
		if !ok {
			violation("malformed " + op)
		}
		e.settle(r, fx)
	})
}

func (e *e2eeState) onCommit(r *e2eeRoom, p *e2eeParticipant, raw json.RawMessage, fx *e2eeEffects) bool {
	var d struct {
		Epoch   uint64   `json:"epoch"`
		Commit  string   `json:"commit"`
		Welcome *string  `json:"welcome"`
		Added   []string `json:"added"`
		Removed []string `json:"removed"`
	}
	if json.Unmarshal(raw, &d) != nil || p.leaf == nil {
		return false
	}
	commit, err := decodeB64url(d.Commit)
	if err != nil {
		return false
	}
	h, err := parseCommitHeader(commit)
	if err != nil || !bytes.Equal(h.groupID, r.groupID) || h.epoch != d.Epoch || h.leafIndex != *p.leaf {
		return false
	}
	if (d.Welcome != nil) != (len(d.Added) > 0) {
		return false
	}
	if d.Welcome != nil {
		if _, err := decodeB64url(*d.Welcome); err != nil {
			return false
		}
		p.expectTree = &treeWait{epoch: d.Epoch + 1}
	}
	if !distinct(d.Added) || !distinct(d.Removed) {
		return false
	}

	reject := func() bool {
		var cur any
		if r.epoch != nil {
			cur = *r.epoch
		}
		p.conn.send("e2ee_commit_rejected", map[string]any{"epoch": d.Epoch, "currentEpoch": cur})
		return true
	}
	if r.epoch == nil || d.Epoch != *r.epoch || r.inFlight() {
		return reject()
	}
	// The roster moved under the committer (a joiner left, a reset): it
	// retries with the roster that it got after this rejection.
	added := make([]*e2eeParticipant, 0, len(d.Added))
	for _, sid := range d.Added {
		q := r.parts[sid]
		if q == nil || !q.pending() || q == p {
			return reject()
		}
		added = append(added, q)
	}
	var removed []*e2eeDeparted
	for _, sid := range d.Removed {
		n := 0
		for _, dep := range r.departed {
			if dep.sessionID == sid && dep.removedIn == 0 {
				removed = append(removed, dep)
				n++
			}
		}
		if n == 0 {
			return reject()
		}
	}

	r.lastTransition++
	t := &e2eeTransition{
		id: r.lastTransition, epoch: d.Epoch + 1, committer: p, committerLeaf: h.leafIndex,
		commit: d.Commit, added: added,
		expected: map[*e2eeParticipant]bool{}, invalid: map[*e2eeParticipant]bool{},
		prevLeaves: map[*e2eeParticipant]*uint32{},
	}
	if d.Welcome != nil {
		t.welcome = *d.Welcome
		p.expectTree.t = t
	}
	next := t.epoch
	r.epoch = &next
	for _, q := range r.parts {
		t.prevLeaves[q] = q.leaf
		if !q.pending() {
			t.expected[q] = true
		}
	}
	for _, q := range added {
		q.addedIn = t.id
		t.expected[q] = true
	}
	for _, dep := range removed {
		dep.removedIn = t.id
	}
	r.transitions = append(r.transitions, t)
	r.stopWork()
	r.dirty = true

	prepare := map[string]any{"transitionId": t.id, "epoch": t.epoch, "commit": t.commit}
	for q := range t.expected {
		if q.addedIn != t.id {
			q.conn.send("e2ee_prepare_transition", prepare)
		}
	}
	t.execTimer = time.AfterFunc(e2eeExecuteTimeout, func() { e.onTimer(r, t, false) })
	t.readyTimer = time.AfterFunc(e2eeReadyTimeout, func() { e.onTimer(r, t, true) })
	e.srv.logger.Printf("room %s: transition %d accepted (epoch %d, committer %s, +%d -%d)", r.id, t.id, t.epoch, p.sessionID, len(added), len(removed))
	return true
}

func (e *e2eeState) onTree(r *e2eeRoom, p *e2eeParticipant, raw json.RawMessage) bool {
	var d struct {
		Epoch       uint64 `json:"epoch"`
		RatchetTree string `json:"ratchetTree"`
	}
	if json.Unmarshal(raw, &d) != nil || p.expectTree == nil || d.Epoch != p.expectTree.epoch {
		return false
	}
	if _, err := decodeB64url(d.RatchetTree); err != nil {
		return false
	}
	t := p.expectTree.t
	p.expectTree = nil
	if t == nil || !r.active(t) {
		return true // the commit lost (or was reverted): nobody needs the tree
	}
	t.tree = d.RatchetTree
	for _, q := range t.added {
		if t.expected[q] {
			q.conn.send("e2ee_welcome", map[string]any{"transitionId": t.id, "epoch": t.epoch, "welcome": t.welcome})
			q.conn.send("e2ee_ratchet_tree", map[string]any{"transitionId": t.id, "epoch": t.epoch, "ratchetTree": t.tree})
		}
	}
	if t.execDue {
		e.execute(t)
	}
	return true
}

func (e *e2eeState) onReady(r *e2eeRoom, p *e2eeParticipant, raw json.RawMessage, fx *e2eeEffects) bool {
	var d struct {
		TransitionID *int64 `json:"transitionId"`
		Epoch        uint64 `json:"epoch"`
		LeafIndex    uint32 `json:"leafIndex"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return false
	}
	if d.TransitionID == nil {
		// The creator made the group (epoch 0, leaf 0).
		if d.Epoch != 0 || d.LeafIndex != 0 || p.leaf != nil {
			return false
		}
		if (r.epoch != nil || r.committer != p) && p.lostCreate {
			// A slow creator lost the role (5 s failover) while its
			// createGroup ran. Its local group has the room's group id, so
			// the roster cannot reset it: the client rejoins.
			e.drop(r, p, fx, closeE2EEResync, "group created after the create failover")
			return true
		}
		if r.epoch != nil || r.committer != p {
			return false
		}
		zero, leaf := uint64(0), uint32(0)
		r.epoch, p.leaf = &zero, &leaf
		r.stopWork()
		r.dirty = true
		e.srv.logger.Printf("room %s: group created by %s", r.id, p.sessionID)
		return true
	}
	t := r.transition(*d.TransitionID)
	if t == nil {
		return *d.TransitionID > 0 && *d.TransitionID <= r.lastTransition // late ready for a resolved transition
	}
	if !t.expected[p] {
		return true
	}
	if d.Epoch != t.epoch {
		return false
	}
	for _, q := range r.parts {
		if q != p && q.leaf != nil && *q.leaf == d.LeafIndex {
			return false // two sessions cannot hold one leaf
		}
	}
	p.acked = max(p.acked, t.id)
	delete(t.invalid, p)
	if p.leaf == nil || *p.leaf != d.LeafIndex {
		leaf := d.LeafIndex
		p.leaf = &leaf
		r.dirty = true
	}
	return true
}

func (e *e2eeState) onInvalid(r *e2eeRoom, p *e2eeParticipant, raw json.RawMessage, fx *e2eeEffects) bool {
	var d struct {
		TransitionID  *int64  `json:"transitionId"`
		Reason        string  `json:"reason"`
		CommitterLeaf *uint32 `json:"committerLeaf"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return false
	}
	var t *e2eeTransition
	if d.TransitionID != nil {
		t = r.transition(*d.TransitionID)
	}
	if t == nil || !t.expected[p] || t.committer == p {
		// The client asks for a resync (rejoin with a new key package).
		e.drop(r, p, fx, closeE2EEResync, "e2ee_invalid: "+d.Reason)
		return true
	}
	e.srv.logger.Printf("room %s: session %s reports transition %d invalid (%s)", r.id, p.sessionID, t.id, d.Reason)
	t.invalid[p] = true
	return true
}

// MARK: - Transitions

func (r *e2eeRoom) transition(id int64) *e2eeTransition {
	for _, t := range r.transitions {
		if t.id == id {
			return t
		}
	}
	return nil
}

func (r *e2eeRoom) active(t *e2eeTransition) bool { return r.transition(t.id) == t }

// inFlight: a transition was not executed yet. Commits wait for it.
func (r *e2eeRoom) inFlight() bool {
	for _, t := range r.transitions {
		if !t.executed {
			return true
		}
	}
	return false
}

func (e *e2eeState) onTimer(r *e2eeRoom, t *e2eeTransition, readyDeadline bool) {
	e.locked(func(fx *e2eeEffects) {
		if e.rooms[r.id] != r || !r.active(t) {
			return
		}
		if !readyDeadline {
			if t.welcome != "" && t.tree == "" {
				// The joiners cannot ack without the tree, and an executed
				// transition cannot be reverted: wait for the tree.
				t.execDue = true
			} else {
				e.execute(t)
			}
		} else if t.welcome != "" && t.tree == "" && r.parts[t.committer.sessionID] == t.committer {
			e.evict(r, t, fx, "no e2ee_ratchet_tree")
		} else {
			for q := range t.expected {
				if q.acked < t.id {
					e.drop(r, q, fx, closeE2EEResync, "no e2ee_ready")
				}
			}
		}
		e.settle(r, fx)
	})
}

func (e *e2eeState) execute(t *e2eeTransition) {
	if t.executed {
		return
	}
	t.executed = true
	msg := map[string]any{"transitionId": t.id, "epoch": t.epoch}
	for q := range t.expected {
		q.conn.send("e2ee_execute_transition", msg)
	}
}

// evaluate applies the §8 "Bad commits" rule and the ready rule to t. It
// returns true when it dropped a participant (the caller evaluates again).
func (e *e2eeState) evaluate(r *e2eeRoom, t *e2eeTransition, fx *e2eeEffects) bool {
	others, invalid := 0, 0
	allDone := true // every member that did not report invalid sent e2ee_ready
	for q := range t.expected {
		if q != t.committer {
			others++
			if t.invalid[q] {
				invalid++
				continue
			}
		}
		if q.acked < t.id {
			allDone = false
		}
	}
	if thr := min(2, others); thr > 0 && invalid >= thr {
		e.evict(r, t, fx, "commit rejected by members")
		return true
	}
	if invalid > 0 && allDone {
		for q := range t.invalid {
			e.drop(r, q, fx, closeE2EEResync, "e2ee_invalid")
		}
		return true
	}
	if allDone {
		e.execute(t)
		e.resolve(r, t)
	}
	return false
}

// evict closes the committer of t with 4014. Before execute, while t is the
// latest transition, the room goes back to the previous epoch, as the members
// do. After execute, the members that acked are on the new epoch and cannot
// go back: the room keeps it, and the members that did not ack (or reported
// t invalid) are on the old epoch, so they resync with 4013.
func (e *e2eeState) evict(r *e2eeRoom, t *e2eeTransition, fx *e2eeEffects, reason string) {
	var behind []*e2eeParticipant
	switch {
	case t.executed:
		for q := range t.expected {
			if q != t.committer && (t.invalid[q] || q.acked < t.id) {
				behind = append(behind, q)
			}
		}
		e.resolve(r, t)
	case r.transitions[len(r.transitions)-1] == t && r.epoch != nil && *r.epoch == t.epoch:
		e.revert(r, t)
	default:
		e.resolve(r, t)
	}
	if r.parts[t.committer.sessionID] == t.committer {
		e.drop(r, t.committer, fx, closeE2EEProtocol, reason)
	}
	for _, q := range behind {
		if r.parts[q.sessionID] == q {
			e.drop(r, q, fx, closeE2EEResync, "behind an evicted transition")
		}
	}
}

func (e *e2eeState) revert(r *e2eeRoom, t *e2eeTransition) {
	prev := t.epoch - 1
	r.epoch = &prev
	for q, leaf := range t.prevLeaves {
		q.leaf = leaf
		if q.acked >= t.id {
			q.acked = t.id - 1
		}
	}
	for _, q := range t.added {
		q.addedIn, q.kpSentTo = 0, nil
	}
	kept := r.departed[:0]
	for _, d := range r.departed {
		if d.removedIn == t.id {
			d.removedIn = 0
		}
		if d.addedIn != t.id {
			kept = append(kept, d)
		}
	}
	r.departed = kept
	r.removeTransition(t)
	r.dirty = true
}

func (e *e2eeState) resolve(r *e2eeRoom, t *e2eeTransition) {
	kept := r.departed[:0]
	for _, d := range r.departed {
		if d.removedIn != t.id {
			kept = append(kept, d)
		}
	}
	r.departed = kept
	r.removeTransition(t)
}

func (r *e2eeRoom) removeTransition(t *e2eeTransition) {
	t.execTimer.Stop()
	t.readyTimer.Stop()
	for i, x := range r.transitions {
		if x == t {
			r.transitions = append(r.transitions[:i], r.transitions[i+1:]...)
			return
		}
	}
}

// MARK: - Settle: committer, roster, key packages, failover

// settle runs after every change: transition rules, room reset, committer
// choice, roster broadcast, key package relay and the failover timer.
func (e *e2eeState) settle(r *e2eeRoom, fx *e2eeEffects) {
	for again := true; again; {
		again = false
		for _, t := range append([]*e2eeTransition(nil), r.transitions...) {
			if r.active(t) && e.evaluate(r, t, fx) {
				again = true
				break
			}
		}
	}
	if len(r.parts) == 0 {
		r.stopWork()
		for _, t := range append([]*e2eeTransition(nil), r.transitions...) {
			r.removeTransition(t)
		}
		delete(e.rooms, r.id)
		return
	}
	if r.epoch != nil && !r.anyInGroup() {
		r.reset() // nobody holds the group state any more: start a new group
	}
	if r.chooseCommitter() {
		r.stopWork()
		r.dirty = true
	}
	if r.dirty && !e.srv.shuttingDown.Load() {
		r.dirty = false
		e.broadcastRoster(r)
	}
	e.relayKeyPackages(r)
	e.armWork(r)
}

func (r *e2eeRoom) anyInGroup() bool {
	for _, p := range r.parts {
		if !p.pending() {
			return true
		}
	}
	return false
}

func (r *e2eeRoom) reset() {
	r.groupID = newVoiceGroupID()
	r.groupIDB64 = encodeB64url(r.groupID)
	r.epoch, r.departed, r.committer = nil, nil, nil
	for _, t := range append([]*e2eeTransition(nil), r.transitions...) {
		r.removeTransition(t)
	}
	for _, p := range r.parts {
		p.leaf, p.addedIn, p.acked, p.kpSentTo, p.demoted, p.expectTree = nil, 0, 0, nil, false, nil
	}
	r.stopWork()
	r.dirty = true
}

// chooseCommitter: before the group exists, the earliest joiner (it
// creates the group). After, the member with the lowest reported leaf that
// did not lose the role. Reports whether the committer changed.
func (r *e2eeRoom) chooseCommitter() bool {
	var best *e2eeParticipant
	for range 2 {
		for _, p := range r.parts {
			switch {
			case r.epoch == nil:
				if best == nil || p.seq < best.seq {
					best = p
				}
			case p.leaf != nil && !p.demoted:
				if best == nil || *p.leaf < *best.leaf {
					best = p
				}
			}
		}
		if best != nil || r.epoch == nil {
			break
		}
		// Every member lost the role once: start the rotation again.
		for _, p := range r.parts {
			p.demoted = false
		}
	}
	changed := best != r.committer
	r.committer = best
	return changed
}

type rosterEntry struct {
	SessionID string  `json:"sessionId"`
	UserID    string  `json:"userId"`
	DeviceID  string  `json:"deviceId"`
	LeafIndex *uint32 `json:"leafIndex"`
}

type pendingEntry struct {
	SessionID string `json:"sessionId"`
	UserID    string `json:"userId"`
	DeviceID  string `json:"deviceId"`
}

func (e *e2eeState) broadcastRoster(r *e2eeRoom) {
	parts := make([]*e2eeParticipant, 0, len(r.parts))
	for _, p := range r.parts {
		parts = append(parts, p)
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].seq < parts[j].seq })
	members, pending, departed := []rosterEntry{}, []pendingEntry{}, []rosterEntry{}
	for _, p := range parts {
		if p.pending() {
			pending = append(pending, pendingEntry{p.sessionID, p.userID, p.deviceID})
		} else {
			members = append(members, rosterEntry{p.sessionID, p.userID, p.deviceID, p.leaf})
		}
	}
	sort.SliceStable(members, func(i, j int) bool { return leafLess(members[i].LeafIndex, members[j].LeafIndex) })
	for _, d := range r.departed {
		if d.removedIn == 0 {
			departed = append(departed, rosterEntry{d.sessionID, d.userID, d.deviceID, d.leaf})
		}
	}
	var committer any
	if r.committer != nil {
		committer = r.committer.sessionID
	}
	var epoch any
	if r.epoch != nil {
		epoch = *r.epoch
	}
	msg := map[string]any{
		"groupId": r.groupIDB64, "epoch": epoch, "committer": committer,
		"create":  r.epoch == nil && r.committer != nil,
		"members": members, "pending": pending, "departed": departed,
	}
	for _, p := range parts {
		p.conn.send("e2ee_roster", msg)
	}
}

// leafLess orders known leaves first, ascending.
func leafLess(a, b *uint32) bool {
	if a == nil || b == nil {
		return a != nil && b == nil
	}
	return *a < *b
}

// relayKeyPackages sends each pending key package to the committer once,
// and again after a committer change.
func (e *e2eeState) relayKeyPackages(r *e2eeRoom) {
	c := r.committer
	if r.epoch == nil || c == nil || c.leaf == nil {
		return
	}
	parts := make([]*e2eeParticipant, 0, len(r.parts))
	for _, p := range r.parts {
		if p.pending() && p != c && p.kpSentTo != c {
			parts = append(parts, p)
		}
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].seq < parts[j].seq })
	for _, p := range parts {
		c.conn.send("e2ee_key_package", map[string]any{"sessionId": p.sessionID, "userId": p.userID, "deviceId": p.deviceID, "keyPackage": p.keyPackage})
		p.kpSentTo = c
	}
}

// hasWork: the committer must create the group, Add a pending joiner or
// Remove a departed leaf.
func (r *e2eeRoom) hasWork() bool {
	if r.committer == nil {
		return false
	}
	if r.epoch == nil {
		return true
	}
	for _, p := range r.parts {
		if p.pending() {
			return true
		}
	}
	for _, d := range r.departed {
		if d.removedIn == 0 {
			return true
		}
	}
	return false
}

// armWork starts the 5 s failover timer when the committer has work and no
// transition blocks commits. The timer is not restarted by more work.
func (e *e2eeState) armWork(r *e2eeRoom) {
	if !r.hasWork() || r.inFlight() {
		r.stopWork()
		return
	}
	if r.workTimer != nil {
		return
	}
	var tm *time.Timer
	tm = time.AfterFunc(e2eeCommitTimeout, func() {
		e.locked(func(fx *e2eeEffects) {
			if e.rooms[r.id] != r || r.workTimer != tm {
				return
			}
			r.workTimer = nil
			if c := r.committer; c != nil && r.hasWork() && !r.inFlight() {
				e.srv.logger.Printf("room %s: committer %s sent no commit in %s", r.id, c.sessionID, e2eeCommitTimeout)
				if r.epoch == nil {
					r.seq++
					c.seq = r.seq // the next joiner creates the group
					c.lostCreate = true
				} else {
					c.demoted = true
				}
				r.dirty = true
			}
			e.settle(r, fx)
		})
	})
	r.workTimer = tm
}

func (r *e2eeRoom) stopWork() {
	if r.workTimer != nil {
		r.workTimer.Stop()
		r.workTimer = nil
	}
}

func distinct(ids []string) bool {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
