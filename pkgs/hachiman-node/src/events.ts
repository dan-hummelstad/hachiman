import { Channel, ChannelChanges } from './channel';
import { ConnectionQualitySample } from './connection-quality-sample';
import { MumbleSocket } from './mumble-socket';
import { SpeakingStateChange } from './speaking-state-change';
import { TextMessageState } from './text-message-state';
import { User, UserChanges } from './user';

// FIXME This _has_ to be type alias instead of interface.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type Events = {
  socketConnect: (socket: MumbleSocket) => void;
  connect: () => void;
  disconnect: (payload?: { reason?: string }) => void;

  channelCreate: (channel: Channel) => void;
  channelUpdate: (channel: Channel, changes: ChannelChanges) => void;
  channelRemove: (channel: Channel) => void;

  userCreate: (user: User) => void;
  userUpdate: (user: User, changes: UserChanges) => void;
  userRemove: (user: User) => void;

  speakingStateChange: (stateChange: SpeakingStateChange) => void;

  textMessage: (messageState: TextMessageState) => void;

  /**
   * Emitted on every inbound Ping response from the server (~every
   * `pingInterval` ms once connected). Carries a measured connection-quality
   * sample for this client's control-channel session — RTT, jitter, and
   * packet-loss. Fields that cannot be derived yet (e.g. jitter before two
   * RTT samples exist) are `null` rather than fabricated.
   */
  connectionQuality: (sample: ConnectionQualitySample) => void;
};
