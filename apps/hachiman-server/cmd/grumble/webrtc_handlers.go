package main

import (
	"encoding/json"

	"github.com/pion/webrtc/v3"
	"google.golang.org/protobuf/proto"
	"mumble.info/grumble/pkg/mumbleproto"
)

// handleWebRTCMessage processes WebRTC SDP messages from clients (answers to
// our offer, or renegotiation).
func (server *Server) handleWebRTCMessage(client *Client, msg *Message) {
	if server.sfu == nil {
		return
	}

	webrtcMsg := &mumbleproto.WebRTC{}
	if err := proto.Unmarshal(msg.buf, webrtcMsg); err != nil {
		client.Panicf("Unable to unmarshal WebRTC message: %v", err)
		return
	}

	sdpType := webrtcMsg.GetSdpType()
	sdp := webrtcMsg.GetSdp()

	if sdpType == "answer" && sdp != "" {
		answer := webrtc.SessionDescription{
			Type: webrtc.SDPTypeAnswer,
			SDP:  sdp,
		}
		if err := server.sfu.HandleAnswer(client.Session(), answer); err != nil {
			server.Printf("WebRTC: failed to handle answer from session %d: %v", client.Session(), err)
		}
	} else if sdpType == "offer" && sdp != "" {
		offer := webrtc.SessionDescription{
			Type: webrtc.SDPTypeOffer,
			SDP:  sdp,
		}
		answerDesc, err := server.sfu.HandleOffer(client.Session(), offer)
		if err != nil {
			server.Printf("WebRTC: failed to handle offer from session %d: %v", client.Session(), err)
			return
		}
		webrtcAnswer := &mumbleproto.WebRTC{
			Sdp:     proto.String(answerDesc.SDP),
			SdpType: proto.String("answer"),
		}
		if err := client.sendMessage(webrtcAnswer); err != nil {
			server.Printf("WebRTC: failed to send answer to session %d: %v", client.Session(), err)
		}
	}
}

// handleIceCandidateMessage processes ICE candidates from WebRTC clients.
func (server *Server) handleIceCandidateMessage(client *Client, msg *Message) {
	if server.sfu == nil {
		return
	}

	iceMsg := &mumbleproto.IceCandidate{}
	if err := proto.Unmarshal(msg.buf, iceMsg); err != nil {
		client.Panicf("Unable to unmarshal IceCandidate message: %v", err)
		return
	}

	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal([]byte(iceMsg.GetContent()), &candidate); err != nil {
		server.Printf("WebRTC: failed to parse ICE candidate from session %d: %v", client.Session(), err)
		return
	}

	if err := server.sfu.AddICECandidate(client.Session(), candidate); err != nil {
		server.Printf("WebRTC: failed to add ICE candidate for session %d: %v", client.Session(), err)
	}
}

// handleTalkingStateMessage processes talking state changes from WebRTC clients.
// When a WebRTC client starts/stops talking, it sends this message instead of
// relying on UDP packet presence.
func (server *Server) handleTalkingStateMessage(client *Client, msg *Message) {
	tsMsg := &mumbleproto.TalkingState{}
	if err := proto.Unmarshal(msg.buf, tsMsg); err != nil {
		client.Panicf("Unable to unmarshal TalkingState message: %v", err)
		return
	}

	target := tsMsg.GetTarget()
	talking := target > 0

	// Update the client's WebRTC talking state
	if client.webrtcClient != nil {
		client.webrtcClient.SetTalkingState(talking, target)
	}

	// Broadcast the talking state to all other clients
	tsBroadcast := &mumbleproto.TalkingState{
		Session: proto.Uint32(client.Session()),
		Target:  proto.Uint32(target),
	}

	for _, other := range server.clients {
		if other == client {
			continue
		}
		if err := other.sendMessage(tsBroadcast); err != nil {
			other.Panicf("Failed to send TalkingState: %v", err)
		}
	}
}

// sendWebRTCRenegotiation creates a new SDP offer for the client and sends it.
// Called when new output tracks have been added dynamically (e.g. a native
// Mumble client starts speaking for the first time).
func (server *Server) sendWebRTCRenegotiation(client *Client) {
	if server.sfu == nil || !client.webrtcEnabled {
		return
	}

	offer, err := server.sfu.CreateOffer(client.Session())
	if err != nil {
		server.Printf("WebRTC: renegotiation failed for session %d: %v", client.Session(), err)
		return
	}

	webrtcOffer := &mumbleproto.WebRTC{
		Sdp:     proto.String(offer.SDP),
		SdpType: proto.String("offer"),
	}
	if err := client.sendMessage(webrtcOffer); err != nil {
		server.Printf("WebRTC: failed to send renegotiation offer to session %d: %v", client.Session(), err)
	}
}

// setupWebRTCForClient initializes WebRTC voice transport for a client
// during authentication. Called from handleAuthenticate when the client
// has set webrtc=true.
func (server *Server) setupWebRTCForClient(client *Client) error {
	if server.sfu == nil {
		return nil
	}

	// Collect sessions of native (non-WebRTC) clients so the SFU can
	// pre-create output tracks for them in the initial offer.
	var nativeSessions []uint32
	for _, c := range server.clients {
		if c != client && !c.webrtcEnabled {
			nativeSessions = append(nativeSessions, c.Session())
		}
	}

	wc, offer, err := server.sfu.AddClient(client.Session(), nativeSessions)
	if err != nil {
		return err
	}

	client.webrtcEnabled = true
	client.webrtcClient = wc
	// Set up the voice callback so incoming WebRTC audio gets broadcast
	// through the normal Mumble voice broadcast system. The frame number is
	// derived from the RTP sequence number by the SFU (with 16->64 bit
	// wraparound handling) — native Mumble decoders require it to be
	// monotonic per sender or playout is silently dropped.
	wc.OnVoice = func(senderSession uint32, opusPayload []byte, _ uint32, frameNum uint64) {
		pkt := &mumbleproto.AudioPacket{
			UsedCodec:       mumbleproto.CodecOpus,
			TargetOrContext: uint8(mumbleproto.TargetRegularSpeech),
			Payload:         opusPayload,
		}
		pkt.SenderSession = senderSession
		pkt.FrameNumber = frameNum
		pkt.OpusData = opusPayload
		vb := NewVoiceBroadcast(client, pkt)
		server.voicebroadcast <- vb
	}

	// Send the WebRTC offer to the client (before ServerSync)
	webrtcMsg := &mumbleproto.WebRTC{
		Sdp:     proto.String(offer.SDP),
		SdpType: proto.String("offer"),
	}
	if err := client.sendMessage(webrtcMsg); err != nil {
		return err
	}

	return nil
}
