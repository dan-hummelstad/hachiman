import { Permissions, type ChannelType, type PermissionName } from '@hachiman/client'
import { hasChat } from '@/lib/model'

export type PermissionGroup = 'general' | 'messages' | 'voice'

export interface PermissionLabel {
  name: PermissionName
  bit: number
  label: string
  hint: string
  group: PermissionGroup
}

/** The groups of the role editor, in the order it shows them. */
export const PERMISSION_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'messages', label: 'Messages' },
  { id: 'voice', label: 'Voice and moderation' }
] as const

const p = (
  group: PermissionGroup,
  name: PermissionName,
  label: string,
  hint: string
): PermissionLabel => ({
  name,
  bit: Permissions[name],
  label,
  hint,
  group
})

/** Human labels for every permission bit, in the order the role editor shows them (group order). */
export const PERMISSION_LABELS: readonly PermissionLabel[] = [
  p('general', 'ADMINISTRATOR', 'Administrator', 'Every permission; bypasses channel overwrites.'),
  p(
    'general',
    'MANAGE_GUILD',
    'Manage space',
    'Rename the space, change its voice region and manage invites.'
  ),
  p(
    'general',
    'MANAGE_ROLES',
    'Manage roles',
    'Edit roles below their highest role and channel permissions.'
  ),
  p('general', 'MANAGE_CHANNELS', 'Manage channels', 'Create, edit, reorder and delete channels.'),
  p('general', 'CREATE_INSTANT_INVITE', 'Create invites', 'Create invite links.'),
  p('general', 'CHANGE_NICKNAME', 'Change nickname', 'Change their own nickname.'),
  p('general', 'MANAGE_NICKNAMES', 'Manage nicknames', "Change other members' nicknames."),
  p(
    'general',
    'MANAGE_EXPRESSIONS',
    'Manage expressions',
    'Upload, rename and delete custom emojis and soundboard sounds.'
  ),
  p('general', 'VIEW_CHANNEL', 'View channels', 'See channels.'),
  p('messages', 'SEND_MESSAGES', 'Send messages', 'Post in text channels.'),
  p('messages', 'MANAGE_MESSAGES', 'Manage messages', "Delete other members' messages."),
  p(
    'messages',
    'READ_MESSAGE_HISTORY',
    'Read message history',
    'See messages sent before they joined.'
  ),
  p('voice', 'CONNECT', 'Connect', 'Join voice channels.'),
  p('voice', 'SPEAK', 'Speak', 'Talk in voice channels.'),
  p('voice', 'USE_SOUNDBOARD', 'Use soundboard', 'Play soundboard sounds in voice channels.'),
  p('voice', 'MUTE_MEMBERS', 'Mute members', 'Mute others in voice for everyone.'),
  p('voice', 'DEAFEN_MEMBERS', 'Deafen members', 'Deafen others in voice for everyone.'),
  p('voice', 'MOVE_MEMBERS', 'Move members', 'Move others between voice channels.'),
  p('voice', 'KICK_MEMBERS', 'Kick members', 'Remove members from the space.'),
  p('voice', 'BAN_MEMBERS', 'Ban members', 'Remove members and stop them from joining again.')
]

const TEXT_BITS: PermissionName[] = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'MANAGE_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'CREATE_INSTANT_INVITE'
]
const VOICE_BITS: PermissionName[] = [
  'VIEW_CHANNEL',
  'CONNECT',
  'SPEAK',
  'USE_SOUNDBOARD',
  'CREATE_INSTANT_INVITE'
]

/** The bits that mean something on a channel of this type (categories: the union). */
export function channelPermissionLabels(type: ChannelType): PermissionLabel[] {
  const names = hasChat(type)
    ? TEXT_BITS
    : type === 'voice'
      ? VOICE_BITS
      : [...TEXT_BITS, ...VOICE_BITS]
  return PERMISSION_LABELS.filter((l) => names.includes(l.name))
}
