/**
 * Voice moderation (docs/gateway-protocol.md §6 "Voice moderation"). Voice
 * states are gateway-owned Redis keys (§5): Takusen reads them, and asks the
 * gateway session of the user to move or disconnect with the internal
 * `VOICE_MOVE` on `user:{userId}`. Server mute and deafen are member columns:
 * the gateway follows the GUILD_MEMBER_UPDATE.
 */
import type { VoiceState } from '@hachiman/client/types'

import { publishJson, redis } from '@/lib/events'

/** The live voice state of `userId` in `guildId`, or null (no state, or its gateway session is gone). */
export async function readVoiceState(guildId: string, userId: string): Promise<VoiceState | null> {
  const r = redis()
  const json = await r.hget(`voice:${guildId}`, userId)
  if (!json) return null
  const state = JSON.parse(json) as VoiceState
  if (!state.channelId || (await r.exists(`session:${state.sessionId}`)) !== 1) return null
  return state
}

/** Internal, not forwarded to clients. `channelId` null: disconnect. */
export async function publishVoiceMove(userId: string, guildId: string, channelId: string | null): Promise<void> {
  await publishJson(`user:${userId}`, { t: 'VOICE_MOVE', d: { guildId, channelId } }, 'VOICE_MOVE')
}
