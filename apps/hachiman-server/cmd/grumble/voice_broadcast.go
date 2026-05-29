package main

import (
	"bytes"
	"math"
	"sort"
	"time"

	"mumble.info/grumble/pkg/mumbleproto"
	"mumble.info/grumble/pkg/web"
)

type VoiceBroadcast struct {
	// The sender who is performing the broadcast
	sender *Client
	// Audio packet which should be broadcast
	packet *mumbleproto.AudioPacket

	// Receivers
	receiver    []voiceReceiver
	receiverMap map[uint32]int
}

type voiceReceiver struct {
	Client           *Client
	HasPositional    bool
	Ctx              mumbleproto.AudioContext
	VolumeAdjustment *VolumeAdjustment
}

func (v *voiceReceiver) VolumeFactor() float32 {
	if v.VolumeAdjustment == nil {
		return 1
	}
	return v.VolumeAdjustment.Factor
}

func (v *voiceReceiver) VolumeDB() int {
	if v.VolumeAdjustment == nil {
		return 0
	}
	return v.VolumeAdjustment.DBAdjustment
}

func (v *voiceReceiver) SupportProtobuf() bool {
	return v.Client.Version.SupportProtobuf()
}

func (v *voiceReceiver) Equal(other *voiceReceiver) bool {
	return v.HasPositional == other.HasPositional &&
		v.SupportProtobuf() == other.SupportProtobuf() &&
		v.Ctx == other.Ctx &&
		math.Abs(float64(v.VolumeFactor()-other.VolumeFactor())) < 0.05 &&
		math.Abs(float64(v.VolumeDB()-other.VolumeDB())) < 5
}

func NewVoiceBroadcast(client *Client, packet *mumbleproto.AudioPacket) *VoiceBroadcast {
	return &VoiceBroadcast{
		sender:      client,
		packet:      packet,
		receiver:    make([]voiceReceiver, 0, 16),
		receiverMap: make(map[uint32]int),
	}
}

func (v *VoiceBroadcast) Target() byte {
	return v.packet.TargetOrContext
}

func (v *VoiceBroadcast) AddReceiver(client *Client, ctx mumbleproto.AudioContext, volAdj *VolumeAdjustment) {
	if client == nil {
		return
	}

	hasPositionalData := len(v.packet.PositionalData) == 3 && bytes.Equal(client.PluginContext, v.sender.PluginContext)
	receiver := voiceReceiver{
		Client:           client,
		HasPositional:    hasPositionalData,
		Ctx:              ctx,
		VolumeAdjustment: volAdj,
	}

	id, ok := v.receiverMap[client.session]
	if ok {
		// Update info.
		if receiver.Ctx < v.receiver[id].Ctx {
			v.receiver[id].Ctx = receiver.Ctx
			v.receiver[id].VolumeAdjustment = receiver.VolumeAdjustment
		}
		oldAdj := float32(1.0)
		newAdj := float32(1.0)
		if v.receiver[id].VolumeAdjustment != nil {
			oldAdj = v.receiver[id].VolumeAdjustment.Factor
		}
		if receiver.VolumeAdjustment != nil {
			newAdj = receiver.VolumeAdjustment.Factor
		}
		if newAdj < oldAdj {
			v.receiver[id].VolumeAdjustment = receiver.VolumeAdjustment
		}
	} else {
		id = len(v.receiver)
		v.receiver = append(v.receiver, receiver)
		v.receiverMap[client.session] = id
	}
}

func (v *VoiceBroadcast) Broadcast() error {
	// Relay region for on-path instrumentation. Both the WebRTC and native
	// forwarding paths below report into the SFU's RelayMetrics so a single
	// place answers "is voice staying on-path?". relayRegion is read once
	// here (off the per-receiver loop) to keep the hot path allocation-free.
	var relayMetrics *web.RelayMetrics
	relayRegion := ""
	if v.sender.server.sfu != nil {
		relayMetrics = v.sender.server.sfu.Metrics
		relayRegion = relayMetrics.Region()
	}

	// Sort by parameter
	sort.Slice(v.receiver, func(i, j int) bool {
		a := v.receiver[i]
		b := v.receiver[j]

		if a.HasPositional != b.HasPositional {
			return a.HasPositional
		}

		if a.SupportProtobuf() != b.SupportProtobuf() {
			return a.SupportProtobuf()
		}

		if a.Ctx != b.Ctx {
			return a.Ctx < b.Ctx
		}

		return a.VolumeFactor() > b.VolumeFactor()
	})

	var lastReceiver voiceReceiver
	var lastBytes []byte = nil

	for _, recv := range v.receiver {
		// WebRTC clients receive audio via the SFU, not UDP
		if recv.Client.webrtcEnabled && recv.Client.webrtcClient != nil && v.sender.server.sfu != nil {
			senderSSRC := uint32(0)
			if v.sender.webrtcClient != nil {
				senderSSRC = v.sender.webrtcClient.SSRC
			} else if ssrc, ok := v.sender.server.sfu.SSRCPool.SSRCForSession(v.sender.Session()); ok {
				senderSSRC = ssrc
			} else {
				// Allocate an SSRC for the native sender so WebRTC clients can identify them
				senderSSRC = v.sender.server.sfu.SSRCPool.Get(v.sender.Session())
			}

			// Marker-bit / talkspurt-start detection is handled inside the
			// SFU based on the wall-clock gap between forwarded packets;
			// no need to pass an explicit isFirst flag.
			//
			// A WebRTC receiver is, by topology, directly served by this
			// relay's regional ingress, so its region equals the relay's
			// region — pass relayRegion so the on-path classifier sees an
			// in-region (on-path) hop. (There is no per-client region field
			// yet; when one lands, thread it through here instead.)
			v.sender.server.sfu.ForwardToWebRTC(
				recv.Client.webrtcClient,
				senderSSRC,
				v.packet.Payload,
				v.packet.FrameNumber,
				relayRegion,
			)
			continue
		}

		if lastBytes == nil || !lastReceiver.Equal(&recv) {
			if !recv.HasPositional {
				v.packet.PositionalData = nil
			}
			v.packet.TargetOrContext = uint8(recv.Ctx)
			volumeAdjustment := recv.VolumeFactor()
			if volumeAdjustment != 1 {
				v.packet.VolumeAdjustment = volumeAdjustment
			} else {
				v.packet.VolumeAdjustment = 0
			}

			bytes, err := v.packet.Data(!recv.SupportProtobuf())
			if err != nil {
				v.sender.server.Panic(err)
			} else {
				lastBytes = bytes
			}

			lastReceiver = recv
		}

		// Instrument the native UDP forwarding hop. The send is the relay's
		// added-latency contribution for native receivers; measure it and
		// record the forward. A native receiver is directly served by this
		// relay, so its region equals relayRegion (on-path). All metrics
		// calls are atomic-only / allocation-free, so ObserveHopLatency runs
		// on every forward (a full-population mean/max, not a sampled subset);
		// the measurement itself is just a monotonic-clock read.
		sendStart := time.Now()
		if err := recv.Client.SendUDP(lastBytes); err != nil {
			if relayMetrics != nil {
				relayMetrics.RecordNativeDrop()
			}
			recv.Client.Panicf("Unable to send UDP message: %v", err.Error())
		} else if relayMetrics != nil {
			relayMetrics.ObserveHopLatency(time.Since(sendStart))
			relayMetrics.RecordNativeForward(len(lastBytes), relayRegion)
		}
	}

	return nil
}
