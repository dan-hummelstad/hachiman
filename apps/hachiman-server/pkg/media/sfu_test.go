// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package media

import (
	"io"
	"log"
	"sync/atomic"
	"testing"

	"github.com/pion/webrtc/v3"
)

func newTestSFU(t *testing.T) *SFU {
	t.Helper()
	s, err := NewSFU(Config{}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type counts struct{ reneg, peers atomic.Int32 }

func (c *counts) hooks() Hooks {
	return Hooks{Renegotiate: func() { c.reneg.Add(1) }, PeersChanged: func() { c.peers.Add(1) }}
}

func mustJoin(t *testing.T, s *SFU, session, user, room string, c *counts) *Client {
	t.Helper()
	cl, _, err := s.Join(session, user, room, nil, c.hooks())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Remove(cl) })
	return cl
}

// sendingTo lists the stream ids dst's PC sends to its client: the peer's
// user id for its mic, "screen-<userId>" for its screen.
func sendingTo(dst *Client) map[string]bool {
	out := map[string]bool{}
	for _, tr := range dst.PC.GetTransceivers() {
		if snd := tr.Sender(); snd != nil && snd.Track() != nil {
			out[snd.Track().StreamID()] = true
		}
	}
	return out
}

func TestSFU_RoomScopedTracksAndHooks(t *testing.T) {
	s := newTestSFU(t)
	var ca, cb, cc counts
	a := mustJoin(t, s, "sA", "uA", "room1", &ca)
	b := mustJoin(t, s, "sB", "uB", "room1", &cb)
	c := mustJoin(t, s, "sC", "uC", "room2", &cc)

	if a.SSRC == b.SSRC || a.SSRC == 0 {
		t.Fatalf("ssrcs a=%d b=%d", a.SSRC, b.SSRC)
	}
	if got := sendingTo(a); !got["uB"] || !got["screen-uB"] || len(got) != 2 {
		t.Errorf("a receives %v, want only uB and screen-uB", got)
	}
	if got := sendingTo(b); !got["uA"] || !got["screen-uA"] || len(got) != 2 {
		t.Errorf("b receives %v, want only uA and screen-uA", got)
	}
	if got := sendingTo(c); len(got) != 0 {
		t.Errorf("c (other room) receives %v, want nothing", got)
	}
	// m-lines 0 and 1 stay the sender-less recvonly mic and screen slots.
	for i, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if tr := a.PC.GetTransceivers()[i]; tr.Sender() != nil || tr.Kind() != kind {
			t.Errorf("upload slot %d: kind %v, sender %v", i, tr.Kind(), tr.Sender())
		}
	}
	if ca.reneg.Load() != 1 || ca.peers.Load() != 1 || cb.reneg.Load() != 0 || cc.reneg.Load() != 0 {
		t.Errorf("hooks: a=%d/%d b=%d c=%d", ca.reneg.Load(), ca.peers.Load(), cb.reneg.Load(), cc.reneg.Load())
	}
	if ps := s.RoomPeers(a); len(ps) != 1 || ps[0] != b {
		t.Errorf("RoomPeers(a) = %v", ps)
	}

	s.Remove(b)
	if got := sendingTo(a); len(got) != 0 {
		t.Errorf("a still receives %v after b left", got)
	}
	if ca.reneg.Load() != 2 || ca.peers.Load() != 2 || cc.peers.Load() != 0 {
		t.Errorf("hooks after remove: a=%d/%d c=%d", ca.reneg.Load(), ca.peers.Load(), cc.peers.Load())
	}
	if s.SessionCount() != 2 || s.ssrcs.Len() != 2 {
		t.Errorf("SessionCount=%d ssrcs=%d, want 2/2", s.SessionCount(), s.ssrcs.Len())
	}
}

func TestSFU_ReplaceAndStaleRemove(t *testing.T) {
	s := newTestSFU(t)
	var n, peer counts
	var left atomic.Value
	h := peer.hooks()
	h.PeerLeft = func(u string) { left.Store(u) }
	p, _, err := s.Join("sP", "uP", "r", nil, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Remove(p) })
	old := mustJoin(t, s, "s1", "u1", "r", &n)
	cur, replaced, err := s.Join("s1", "u1", "r", nil, n.hooks())
	if err != nil || replaced != old {
		t.Fatalf("replacing Join: replaced=%p old=%p err=%v", replaced, old, err)
	}
	t.Cleanup(func() { s.Remove(cur) })
	if left.Load() != "u1" {
		t.Errorf("peer PeerLeft = %v, want u1", left.Load())
	}
	if got := sendingTo(p); len(got) != 2 || !got["u1"] || !got["screen-u1"] {
		t.Errorf("peer receives %v after replace, want one u1 mic and screen", got)
	}
	s.Remove(old) // stale pointer must not evict the successor
	if s.SessionCount() != 2 || s.RoomPeers(cur) == nil {
		t.Fatalf("stale Remove evicted successor (count=%d)", s.SessionCount())
	}
}

func TestSFU_KeyframeRequestsThrottled(t *testing.T) {
	s := newTestSFU(t)
	var n counts
	c := mustJoin(t, s, "s1", "u1", "r", &n)
	c.requestKeyframe()
	if c.lastKeyframeReq.Load() != 0 {
		t.Fatal("PLI sent before the client shared")
	}
	c.screenSSRC.Store(42)
	c.requestKeyframe()
	first := c.lastKeyframeReq.Load()
	c.requestKeyframe()
	if first == 0 || c.lastKeyframeReq.Load() != first {
		t.Fatalf("second PLI within %v was not dropped", keyframeReqInterval)
	}
	c.lastKeyframeReq.Store(first - int64(keyframeReqInterval))
	c.requestKeyframe()
	if c.lastKeyframeReq.Load() <= first-int64(keyframeReqInterval) {
		t.Fatal("PLI after the interval was dropped")
	}
}
