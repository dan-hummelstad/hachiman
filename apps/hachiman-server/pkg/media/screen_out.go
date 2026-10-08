// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package media

import (
	"sync/atomic"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v3"
)

// screenOut is one viewer's copy of a sharer's screen video and screen audio.
// Each viewer has its own tracks, so the SFU can stop the share for one
// viewer (screen_subscribe, §8) without a renegotiation: the transceivers
// stay, only the writes stop.
type screenOut struct {
	video    *webrtc.TrackLocalStaticRTP
	videoSeq seqMap
	audio    *webrtc.TrackLocalStaticRTP
	audioSeq seqMap
	// on is true while the viewer subscribes to the sharer.
	on atomic.Bool
}

func newScreenOut(userID string) (*screenOut, error) {
	stream := "screen-" + userID
	video, err := webrtc.NewTrackLocalStaticRTP(vp8Codec, stream, stream)
	if err != nil {
		return nil, err
	}
	audio, err := webrtc.NewTrackLocalStaticRTP(opusCodec, "screen-audio-"+userID, stream)
	if err != nil {
		return nil, err
	}
	return &screenOut{video: video, audio: audio}, nil
}

// set turns the forwarding on or off and reports whether it turned on.
// Callers hold SFU.mu, so set calls never race each other.
func (o *screenOut) set(on bool) bool {
	if !on || o.on.Load() {
		o.on.Store(on)
		return false
	}
	o.videoSeq.resync.Store(true)
	o.audioSeq.resync.Store(true)
	o.on.Store(true)
	return true
}

// seqMap keeps the RTP sequence numbers of one viewer's copy of a stream
// contiguous over the gaps while the viewer is unsubscribed. Without it a
// viewer that subscribes again sees a jump of thousands of packets, and its
// NACK logic asks for all of them. SFrame does not use the RTP sequence
// number (§12.10.2), so the rewrite does not touch the E2EE. Only the forward
// goroutine of the stream calls write.
type seqMap struct {
	// resync is set when the forwarding starts again.
	resync  atomic.Bool
	started bool
	offset  uint16
	// first is the inbound sequence number of the first packet after the
	// last resync. For the next guard packets, older packets that arrive
	// late are dropped: their mapped numbers would repeat ones that the
	// viewer already got.
	first uint16
	guard int
	last  uint16
}

// seqGuardPackets bounds the late-packet check after a resync. Far below
// 2^15, so the int16 comparison cannot wrap.
const seqGuardPackets = 1024

func (m *seqMap) write(out *webrtc.TrackLocalStaticRTP, pkt *rtp.Packet) {
	seq, ok := m.next(pkt.SequenceNumber)
	if !ok {
		return
	}
	cp := *pkt
	cp.SequenceNumber = seq
	// ErrClosedPipe just means the viewer's transceiver is not bound yet.
	_ = out.WriteRTP(&cp)
}

// next maps an inbound sequence number to the viewer's. False drops the
// packet.
func (m *seqMap) next(in uint16) (uint16, bool) {
	if m.resync.Swap(false) || !m.started {
		if m.started {
			m.offset = m.last + 1 - in
		}
		m.first = in
		m.guard = seqGuardPackets
		m.last = in + m.offset
		m.started = true
	} else if m.guard > 0 {
		m.guard--
		if int16(in-m.first) < 0 {
			return 0, false
		}
	}
	out := in + m.offset
	if int16(out-m.last) > 0 {
		m.last = out
	}
	return out, true
}
