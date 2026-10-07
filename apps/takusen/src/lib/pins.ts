/**
 * Pinned messages (docs/gateway-protocol.md §4 "Pins, guild events and blocks"). The server stores
 * which message ids are pinned, by whom and when. It learns no content.
 */
import { has, Permissions } from '@hachiman/client/permissions'

import { ApiError, MissingPermissionsError } from '@/lib/errors'

export const MAX_PINS_PER_CHANNEL = 50

/** 400 `TooManyPins` when the channel already holds the maximum. */
export function assertPinRoom(currentPins: number): void {
  if (currentPins >= MAX_PINS_PER_CHANNEL) {
    throw new ApiError('TooManyPins', 400, `A channel holds at most ${MAX_PINS_PER_CHANNEL} pins`)
  }
}

/** Guild channels: MANAGE_MESSAGES. DMs and group DMs: any participant. */
export function assertCanPin(access: { channel: { guildId: string | null }; permissions: number }): void {
  if (access.channel.guildId === null) return
  if (!has(access.permissions, Permissions.MANAGE_MESSAGES)) throw new MissingPermissionsError()
}
