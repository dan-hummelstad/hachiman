import { Permissions, type ChannelType, type PermissionName } from '@hachiman/client'

export interface PermissionLabel {
  name: PermissionName
  bit: number
  label: string
  hint: string
}

const p = (name: PermissionName, label: string, hint: string): PermissionLabel => ({
  name,
  bit: Permissions[name],
  label,
  hint
})

/** Human labels for every permission bit, in the order the role editor shows them. */
export const PERMISSION_LABELS: readonly PermissionLabel[] = [
  p('ADMINISTRATOR', 'Administrator', 'Every permission; bypasses channel overwrites.'),
  p(
    'MANAGE_GUILD',
    'Manage guild',
    'Rename the guild, change its voice region and manage invites.'
  ),
  p('MANAGE_ROLES', 'Manage roles', 'Edit roles below their highest role and channel permissions.'),
  p('MANAGE_CHANNELS', 'Manage channels', 'Create, edit, reorder and delete channels.'),
  p('KICK_MEMBERS', 'Kick members', 'Remove members from the guild.'),
  p('CREATE_INSTANT_INVITE', 'Create invites', 'Create invite links.'),
  p('CHANGE_NICKNAME', 'Change nickname', 'Change their own nickname.'),
  p('MANAGE_NICKNAMES', 'Manage nicknames', "Change other members' nicknames."),
  p('VIEW_CHANNEL', 'View channels', 'See channels.'),
  p('SEND_MESSAGES', 'Send messages', 'Post in text channels.'),
  p('MANAGE_MESSAGES', 'Manage messages', "Delete other members' messages."),
  p('READ_MESSAGE_HISTORY', 'Read message history', 'See messages sent before they joined.'),
  p('CONNECT', 'Connect', 'Join voice channels.'),
  p('SPEAK', 'Speak', 'Talk in voice channels.'),
  p('MUTE_MEMBERS', 'Mute members', 'Mute others in voice for everyone.'),
  p('DEAFEN_MEMBERS', 'Deafen members', 'Deafen others in voice for everyone.'),
  p('MOVE_MEMBERS', 'Move members', 'Move others between voice channels.')
]

const TEXT_BITS: PermissionName[] = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'MANAGE_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'CREATE_INSTANT_INVITE'
]
const VOICE_BITS: PermissionName[] = ['VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'CREATE_INSTANT_INVITE']

/** The bits that mean something on a channel of this type (categories: the union). */
export function channelPermissionLabels(type: ChannelType): PermissionLabel[] {
  const names =
    type === 'text' ? TEXT_BITS : type === 'voice' ? VOICE_BITS : [...TEXT_BITS, ...VOICE_BITS]
  return PERMISSION_LABELS.filter((l) => names.includes(l.name))
}
