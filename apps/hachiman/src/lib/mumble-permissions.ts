/**
 * Mumble channel permission bits, mirrored from
 * `apps/hachiman-server/pkg/acl/acl.go` and
 * `pkgs/hachiman-node/src/permissions.ts`. Each entry includes the bitmask, a
 * short label for the UI, and a one-sentence description for users who
 * haven't internalized Mumble's permission model.
 *
 * Two halves:
 *   - CHANNEL_PERMISSIONS — apply to the channel they're set on; the common
 *     case (speak, write, enter, etc.).
 *   - ROOT_PERMISSIONS — additionally meaningful only on the root channel
 *     (kick, ban, register). The UI groups them separately so root-channel
 *     role editors expose them but per-channel ACL editors don't surface
 *     irrelevant bits.
 *
 * Bit values are uint32; we use plain numbers because none exceed 2^31.
 */

export interface PermissionDef {
  /** Stable key used in React lists and persistence keys. */
  key: string
  /** Bitmask value. Combine with bitwise OR. */
  bit: number
  /** Short capitalized label for the toggle UI. */
  label: string
  /** Plain-English explanation, single sentence. */
  description: string
}

export const CHANNEL_PERMISSIONS: PermissionDef[] = [
  {
    key: 'write',
    bit: 0x1,
    label: 'Modify channel',
    description: 'Edit this channel and grant any other permission to anyone on it.'
  },
  {
    key: 'traverse',
    bit: 0x2,
    label: 'Pass through',
    description: 'See and walk through this channel on the way to its sub-channels.'
  },
  {
    key: 'enter',
    bit: 0x4,
    label: 'Join channel',
    description: 'Switch into this channel.'
  },
  {
    key: 'speak',
    bit: 0x8,
    label: 'Speak',
    description: 'Transmit voice while in this channel.'
  },
  {
    key: 'whisper',
    bit: 0x100,
    label: 'Whisper / shout',
    description: 'Send a directed voice transmission to users in this channel from elsewhere.'
  },
  {
    key: 'textMessage',
    bit: 0x200,
    label: 'Send messages',
    description: 'Post text messages in this channel.'
  },
  {
    key: 'listen',
    bit: 0x800,
    label: 'Listen-link',
    description: 'Subscribe to this channel’s audio without joining it.'
  },
  {
    key: 'muteDeafen',
    bit: 0x10,
    label: 'Mute / deafen others',
    description: 'Force-mute or deafen other users in this channel.'
  },
  {
    key: 'move',
    bit: 0x20,
    label: 'Move users',
    description: 'Drag other users between channels.'
  },
  {
    key: 'makeChannel',
    bit: 0x40,
    label: 'Create channels',
    description: 'Create new permanent sub-channels under this one.'
  },
  {
    key: 'makeTempChannel',
    bit: 0x400,
    label: 'Create temporary channels',
    description: 'Create throw-away sub-channels that disappear when the last user leaves.'
  },
  {
    key: 'linkChannel',
    bit: 0x80,
    label: 'Link channels',
    description: 'Bridge audio from this channel to other channels you can also link.'
  }
]

export const ROOT_PERMISSIONS: PermissionDef[] = [
  {
    key: 'kick',
    bit: 0x10000,
    label: 'Kick users',
    description: 'Disconnect any user from the server.'
  },
  {
    key: 'ban',
    bit: 0x20000,
    label: 'Ban users',
    description: 'Block a user (and their IP) from connecting to the server.'
  },
  {
    key: 'register',
    bit: 0x40000,
    label: 'Register users',
    description: 'Promote anyone to a registered server account, or remove that registration.'
  },
  {
    key: 'selfRegister',
    bit: 0x80000,
    label: 'Self-register',
    description: 'Let the user create their own registered account on this server.'
  },
  {
    key: 'resetUserContent',
    bit: 0x100000,
    label: 'Reset user content',
    description: 'Erase the server-stored comment/avatar of any other user.'
  }
]

export const ALL_PERMISSIONS: PermissionDef[] = [...CHANNEL_PERMISSIONS, ...ROOT_PERMISSIONS]

/**
 * Reserved Mumble groups that always exist on the root channel. Editing
 * their membership is meaningless — they're computed by the server (e.g.
 * `~admin` resolves to users in the `admin` group, `auth` is "any
 * registered user"). We surface them in the picker but disable membership
 * edits.
 */
export const BUILTIN_GROUPS: ReadonlySet<string> = new Set([
  'all',
  'auth',
  'strong_auth',
  'in',
  'out',
  'sub',
  '~in',
  '~out',
  '~sub',
  '~all',
  '~auth',
  '~strong_auth'
])

export function permissionLabel(bit: number): string {
  return ALL_PERMISSIONS.find((p) => p.bit === bit)?.label ?? `0x${bit.toString(16)}`
}
