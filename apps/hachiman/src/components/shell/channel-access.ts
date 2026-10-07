import { Permissions, has, type Channel } from '@hachiman/client'

export interface ChannelAccess {
  /** A text channel in which `@everyone` cannot send: an announcement channel (decision 7). */
  readOnly: boolean
  /** `@everyone` cannot view the channel: only some roles see it (decision 8). */
  restricted: boolean
}

const OPEN: ChannelAccess = { readOnly: false, restricted: false }

/**
 * What `@everyone` (role id = guild id) may do in a channel: its guild-wide permissions with the
 * channel's `@everyone` overwrite applied. Not the viewer's own permissions: the marks tell
 * everyone the same thing about the channel.
 */
export function channelAccess(
  channel: Pick<Channel, 'type' | 'permissionOverwrites'>,
  guildId: string,
  everyonePermissions: number
): ChannelAccess {
  if (channel.type === 'category') return OPEN
  if (has(everyonePermissions, Permissions.ADMINISTRATOR)) return OPEN
  const ow = channel.permissionOverwrites.find((o) => o.type === 'role' && o.id === guildId)
  const p = ow ? (everyonePermissions & ~ow.deny) | ow.allow : everyonePermissions
  const restricted = !has(p, Permissions.VIEW_CHANNEL)
  const readOnly = channel.type === 'text' && !restricted && !has(p, Permissions.SEND_MESSAGES)
  return restricted || readOnly ? { readOnly, restricted } : OPEN
}
