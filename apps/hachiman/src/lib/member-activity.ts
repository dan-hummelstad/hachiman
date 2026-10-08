import type { Channel, Guild, VoiceState } from '@hachiman/client'

/** Where a user is in voice, as the members column and the DM profile show it. */
export interface VoiceActivity {
  guildId: string
  channelId: string
  channelName: string
  /** The guild name when the channel is not in the guild of the context, else null. */
  otherGuildName: string | null
  /** Known only in the own call: media reports the speakers of that call only. */
  speaking: boolean
  streaming: boolean
  /** The user is in the same call as the viewer. */
  withMe: boolean
  /** RFC 3339 join time of the session, when the gateway sends it. */
  joinedAt: string | null
}

export interface ActivitySources {
  /** guildId → userId → state. The viewer gets states only for guilds it is a member of. */
  voiceStates: ReadonlyMap<string, ReadonlyMap<string, VoiceState>>
  channels: ReadonlyMap<string, Channel>
  guilds: ReadonlyMap<string, Guild>
  speaking: ReadonlySet<string>
  /** The viewer's own call, or null. */
  myChannelId: string | null
}

/**
 * The voice activity of `userId`. A state in `contextGuildId` comes first. A state in another guild
 * shows only because the viewer shares that guild (the gateway sends no other states), and it
 * names that guild. Null when the user is in no voice channel the viewer can see.
 */
export function voiceActivity(
  userId: string,
  contextGuildId: string | null,
  src: ActivitySources
): VoiceActivity | null {
  let state = contextGuildId ? src.voiceStates.get(contextGuildId)?.get(userId) : undefined
  if (!state?.channelId) {
    state = undefined
    for (const [guildId, states] of src.voiceStates) {
      if (guildId === contextGuildId) continue
      const s = states.get(userId)
      if (s?.channelId) {
        state = s
        break
      }
    }
  }
  if (!state?.channelId) return null
  const channel = src.channels.get(state.channelId)
  if (!channel) return null
  const withMe = src.myChannelId === state.channelId
  return {
    guildId: state.guildId,
    channelId: state.channelId,
    channelName: channel.name ?? 'voice',
    otherGuildName:
      state.guildId === contextGuildId ? null : (src.guilds.get(state.guildId)?.name ?? null),
    speaking: withMe && src.speaking.has(userId),
    streaming: state.selfStream,
    withMe,
    joinedAt: state.joinedAt ?? null
  }
}

/** "In Lounge", with " · Guild" for a channel of another guild. */
export function activityLabel(a: VoiceActivity): string {
  const where = a.otherGuildName ? `${a.channelName} · ${a.otherGuildName}` : a.channelName
  return `In ${where}`
}
