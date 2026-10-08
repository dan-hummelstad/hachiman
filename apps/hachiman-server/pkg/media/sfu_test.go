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
	// m-lines 0 to 2 stay the sender-less recvonly mic, screen and screen
	// audio slots.
	for i, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if tr := a.PC.GetTransceivers()[i]; tr.Sender() != nil || tr.Kind() != kind {
			t.Errorf("upload slot %d: kind %v, sender %v", i, tr.Kind(), tr.Sender())
		}
	}
	ids := map[string]bool{}
	for _, tr := range a.PC.GetTransceivers() {
		if snd := tr.Sender(); snd != nil && snd.Track() != nil {
			ids[snd.Track().ID()] = true
		}
	}
	if len(ids) != 3 || !ids["audio-uB"] || !ids["screen-uB"] || !ids["screen-audio-uB"] {
		t.Errorf("a's tracks of b = %v", ids)
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

// screenOn reports whether src forwards its screen to dst.
func screenOn(src, dst *Client) bool {
	src.viewersMu.RLock()
	defer src.viewersMu.RUnlock()
	o := src.viewers[dst.SessionID]
	return o != nil && o.on.Load()
}

func TestSFU_ScreenSubscriptions(t *testing.T) {
	s := newTestSFU(t)
	var n counts
	a := mustJoin(t, s, "sA", "uA", "r", &n)
	b := mustJoin(t, s, "sB", "uB", "r", &n)
	c := mustJoin(t, s, "sC", "uC", "r", &n)
	if screenOn(b, a) || screenOn(a, b) || screenOn(b, c) {
		t.Fatal("a screen is forwarded before any screen_subscribe")
	}
	renegBefore := n.reneg.Load()

	b.screenSSRC.Store(42)
	s.SetScreenSubscriptions(a, []string{"uB"})
	if !screenOn(b, a) || screenOn(b, c) || screenOn(c, a) {
		t.Fatalf("after a subscribed to uB: b->a %v, b->c %v, c->a %v", screenOn(b, a), screenOn(b, c), screenOn(c, a))
	}
	if b.lastKeyframeReq.Load() == 0 {
		t.Error("subscribing sent no keyframe request to the sharer")
	}
	if n.reneg.Load() != renegBefore {
		t.Error("a subscription renegotiated")
	}

	// A sharer that rejoins keeps the viewer's subscription.
	b2, _, err := s.Join("sB", "uB", "r", nil, n.hooks())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Remove(b2) })
	if !screenOn(b2, a) || screenOn(b2, c) {
		t.Fatalf("after uB rejoined: b->a %v, b->c %v", screenOn(b2, a), screenOn(b2, c))
	}

	s.SetScreenSubscriptions(a, nil)
	if screenOn(b2, a) {
		t.Fatal("unsubscribe left the screen on")
	}
	s.Remove(a)
	s.SetScreenSubscriptions(a, []string{"uB"}) // removed client: no-op
	if screenOn(b2, a) || b2.viewers[a.SessionID] != nil {
		t.Fatal("a removed viewer still has a screen output")
	}
}

func TestSeqMap_ContiguousOverGaps(t *testing.T) {
	var m seqMap
	for in := uint16(100); in < 103; in++ {
		if out, ok := m.next(in); !ok || out != in {
			t.Fatalf("next(%d) = %d, %v", in, out, ok)
		}
	}
	// Unsubscribed while the sharer sent 103..65000, then subscribed again.
	m.resync.Store(true)
	if out, ok := m.next(65001); !ok || out != 103 {
		t.Fatalf("first packet after the gap = %d, %v, want 103", out, ok)
	}
	if out, ok := m.next(65002); !ok || out != 104 {
		t.Fatalf("next = %d, want 104", out)
	}
	if _, ok := m.next(64999); ok {
		t.Fatal("a late packet from before the resync was forwarded")
	}
	// The inbound wrap at 65535 maps straight through.
	for in := uint16(65003); in != 10; in++ {
		if _, ok := m.next(in); !ok {
			t.Fatalf("next(%d) dropped", in)
		}
	}
	// offset = 103 - 65001 (mod 2^16) = 638
	if out, _ := m.next(10); out != 648 {
		t.Fatalf("after the wrap = %d", out)
	}
}
