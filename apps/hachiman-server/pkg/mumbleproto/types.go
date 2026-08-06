// Copyright (c) 2011 The Grumble Authors
// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package mumbleproto

// Packet-type registry. This MUST stay in lock-step with:
//   - the doc comment block at the top of Mumble.proto
//   - pkgs/hachiman-node/src/packet-type-registry.ts
//
// `proto-sync-checker` enforces no drift between the three.
//
// IDs 1 (UDPTunnel) / 15 (CryptSetup) / 19 (VoiceTarget) are PERMANENTLY
// BURNED — see Mumble.proto's top-of-file comment. They were deleted in the
// media-plane phase 2 protocol cut and the legacy types (`UDPTunnel`,
// `CryptSetup`, `VoiceTarget`, plus the `MumbleUDP.proto`-derived
// `AudioUDP` / `PingUDP`) no longer exist anywhere in the codebase. The
// `Message<Name>` constants for the burned IDs are intentionally NOT
// re-declared: there is no `MessageType()` case for them, no dispatch
// branch, no `proto.Marshal` call site — surfacing them as constants would
// invite exactly the kind of accidental reuse the burn is meant to prevent.
const (
	MessageVersion                uint16 = 0
	MessageAuthenticate           uint16 = 2
	MessagePing                   uint16 = 3
	MessageReject                 uint16 = 4
	MessageServerSync             uint16 = 5
	MessageChannelRemove          uint16 = 6
	MessageChannelState           uint16 = 7
	MessageUserRemove             uint16 = 8
	MessageUserState              uint16 = 9
	MessageBanList                uint16 = 10
	MessageTextMessage            uint16 = 11
	MessagePermissionDenied       uint16 = 12
	MessageACL                    uint16 = 13
	MessageQueryUsers             uint16 = 14
	MessageContextActionModify    uint16 = 16
	MessageContextAction          uint16 = 17
	MessageUserList               uint16 = 18
	MessagePermissionQuery        uint16 = 20
	MessageCodecVersion           uint16 = 21
	MessageUserStats              uint16 = 22
	MessageRequestBlob            uint16 = 23
	MessageServerConfig           uint16 = 24
	MessageSuggestConfig          uint16 = 25
	MessagePluginDataTransmission uint16 = 26
	MessageWebRTC                 uint16 = 27
	MessageIceCandidate           uint16 = 28
	MessageTalkingState           uint16 = 29
	MessageRequestChannelMessages uint16 = 30
	MessageChannelMessageHistory  uint16 = 31
	MessageRelayMetricsQuery      uint16 = 32
	MessageRelayMetricsSnapshot   uint16 = 33

	// ─── media-plane phase 2 additions ────────────────────────────────────
	MessageVoiceTokenRequest     uint16 = 34
	MessageVoiceTokenGrant       uint16 = 35
	MessageMediaTrackPublish     uint16 = 36
	MessageMediaTrackUnpublish   uint16 = 37
	MessageMediaTrackSubscribe   uint16 = 38
	MessageMediaTrackUnsubscribe uint16 = 39
	MessageScreenShareStart      uint16 = 40
	MessageScreenShareStop       uint16 = 41
	MessageQualityProfile        uint16 = 42
	MessageE2EEKeyMaterial       uint16 = 43
)

// MessageType returns the numeric value identifying the message type of msg on the wire.
func MessageType(msg interface{}) uint16 {
	switch msg.(type) {
	case *Version:
		return MessageVersion
	case *Authenticate:
		return MessageAuthenticate
	case *Ping:
		return MessagePing
	case *Reject:
		return MessageReject
	case *ServerSync:
		return MessageServerSync
	case *ChannelRemove:
		return MessageChannelRemove
	case *ChannelState:
		return MessageChannelState
	case *UserRemove:
		return MessageUserRemove
	case *UserState:
		return MessageUserState
	case *BanList:
		return MessageBanList
	case *TextMessage:
		return MessageTextMessage
	case *PermissionDenied:
		return MessagePermissionDenied
	case *ACL:
		return MessageACL
	case *QueryUsers:
		return MessageQueryUsers
	case *ContextActionModify:
		return MessageContextActionModify
	case *ContextAction:
		return MessageContextAction
	case *UserList:
		return MessageUserList
	case *PermissionQuery:
		return MessagePermissionQuery
	case *CodecVersion:
		return MessageCodecVersion
	case *UserStats:
		return MessageUserStats
	case *RequestBlob:
		return MessageRequestBlob
	case *ServerConfig:
		return MessageServerConfig
	case *SuggestConfig:
		return MessageSuggestConfig
	case *PluginDataTransmission:
		return MessagePluginDataTransmission
	case *WebRTC:
		return MessageWebRTC
	case *IceCandidate:
		return MessageIceCandidate
	case *TalkingState:
		return MessageTalkingState
	case *RequestChannelMessages:
		return MessageRequestChannelMessages
	case *ChannelMessageHistory:
		return MessageChannelMessageHistory
	case *RelayMetricsQuery:
		return MessageRelayMetricsQuery
	case *RelayMetricsSnapshot:
		return MessageRelayMetricsSnapshot
	// ─── media-plane phase 2 additions ────────────────────────────────────
	case *VoiceTokenRequest:
		return MessageVoiceTokenRequest
	case *VoiceTokenGrant:
		return MessageVoiceTokenGrant
	case *MediaTrackPublish:
		return MessageMediaTrackPublish
	case *MediaTrackUnpublish:
		return MessageMediaTrackUnpublish
	case *MediaTrackSubscribe:
		return MessageMediaTrackSubscribe
	case *MediaTrackUnsubscribe:
		return MessageMediaTrackUnsubscribe
	case *ScreenShareStart:
		return MessageScreenShareStart
	case *ScreenShareStop:
		return MessageScreenShareStop
	case *QualityProfile:
		return MessageQualityProfile
	case *E2EEKeyMaterial:
		return MessageE2EEKeyMaterial
	}
	panic("unknown type")
}
