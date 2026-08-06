import {
  ACL,
  Authenticate,
  BanList,
  ChannelMessageHistory,
  ChannelRemove,
  ChannelState,
  CodecVersion,
  ContextAction,
  ContextActionModify,
  E2EEKeyMaterial,
  IceCandidate,
  MediaTrackPublish,
  MediaTrackSubscribe,
  MediaTrackUnpublish,
  MediaTrackUnsubscribe,
  PermissionDenied,
  PermissionQuery,
  Ping,
  PluginDataTransmission,
  QualityProfile,
  QueryUsers,
  Reject,
  RelayMetricsQuery,
  RelayMetricsSnapshot,
  RequestBlob,
  RequestChannelMessages,
  ScreenShareStart,
  ScreenShareStop,
  ServerConfig,
  ServerSync,
  SuggestConfig,
  TalkingState,
  TextMessage,
  UserList,
  UserRemove,
  UserState,
  UserStats,
  Version,
  VoiceTokenGrant,
  VoiceTokenRequest,
  WebRTC,
} from './mumbleproto';
import { MessageType } from '@protobuf-ts/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = MessageType<any>;

// Packet-type registry — keep in sync with:
//   - apps/hachiman-server/pkg/mumbleproto/Mumble.proto (top-of-file comment)
//   - apps/hachiman-server/pkg/mumbleproto/types.go
// `proto-sync-checker` enforces no drift between the three.
//
// IDs 1 (UDPTunnel), 15 (CryptSetup), and 19 (VoiceTarget) are PERMANENTLY
// BURNED — they were deleted in the media-plane phase 2 protocol cut. Do not
// reuse the IDs even for unrelated messages; see Mumble.proto for the
// rationale.
//
// See: MEDIA-PLANE-MIGRATION.md "Phase 2 — Protocol changes".
const packetForPacketType = new Map<number, AnyMessage>([
  [0, Version],
  // 1 reserved — was UDPTunnel
  [2, Authenticate],
  [3, Ping],
  [4, Reject],
  [5, ServerSync],
  [6, ChannelRemove],
  [7, ChannelState],
  [8, UserRemove],
  [9, UserState],
  [10, BanList],
  [11, TextMessage],
  [12, PermissionDenied],
  [13, ACL],
  [14, QueryUsers],
  // 15 reserved — was CryptSetup
  [16, ContextActionModify],
  [17, ContextAction],
  [18, UserList],
  // 19 reserved — was VoiceTarget
  [20, PermissionQuery],
  [21, CodecVersion],
  [22, UserStats],
  [23, RequestBlob],
  [24, ServerConfig],
  [25, SuggestConfig],
  [26, PluginDataTransmission],
  [27, WebRTC],
  [28, IceCandidate],
  [29, TalkingState],
  [30, RequestChannelMessages],
  [31, ChannelMessageHistory],
  [32, RelayMetricsQuery],
  [33, RelayMetricsSnapshot],
  // ─── media-plane phase 2 additions ──────────────────────────────────────
  [34, VoiceTokenRequest],
  [35, VoiceTokenGrant],
  [36, MediaTrackPublish],
  [37, MediaTrackUnpublish],
  [38, MediaTrackSubscribe],
  [39, MediaTrackUnsubscribe],
  [40, ScreenShareStart],
  [41, ScreenShareStop],
  [42, QualityProfile],
  [43, E2EEKeyMaterial],
]);

const packetTypeForPacket = new Map<AnyMessage, number>();
for (const [key, value] of packetForPacketType.entries()) {
  packetTypeForPacket.set(value, key);
}

/**
 * @internal
 */
export const packetForType = (type: number) => {
  return packetForPacketType.get(type);
};

/**
 * @internal
 */
export const packetType = (packet: AnyMessage) => {
  return packetTypeForPacket.get(packet);
};
