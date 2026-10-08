/**
 * Voice moderation (docs/gateway-protocol.md §6 "Voice moderation"). Voice
 * states are gateway-owned Redis keys (§5): Takusen reads them, and asks the
 * gateway session of the user to move or disconnect with the internal
 * `VOICE_MOVE` on `user:{userId}`. Server mute and deafen are member columns:
 * the gateway follows the GUILD_MEMBER_UPDATE.
 */
import { publishJson } from '@/lib/events'

export { readVoiceState } from '@/lib/guilds'

/** Internal, not forwarded to clients. `channelId` null: disconnect. */
export async function publishVoiceMove(userId: string, guildId: string, channelId: string | null): Promise<void> {
  await publishJson(`user:${userId}`, { t: 'VOICE_MOVE', d: { guildId, channelId } }, 'VOICE_MOVE')
}
