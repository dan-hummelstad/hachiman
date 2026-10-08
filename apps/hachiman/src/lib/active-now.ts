import type { Channel, Guild, VoiceState } from '@hachiman/client'

/** One voice channel with people in it, as the "Active now" column shows it (E1). */
export interface ActiveCall {
  guildId: string
  guildName: string
  channelId: string
  channelName: string
  /** The people in the channel, in join order (gateway order when no join time). */
  userIds: string[]
  /** The first person who streams, or null. */
  streamerId: string | null
  /** The viewer is in this call. */
  withMe: boolean
}

/**
 * The voice channels with people in them, across the guilds whose voice states the viewer gets
 * (the guilds the viewer shares). The viewer's own call comes first, then live calls, then the
 * larger calls. A call with only the viewer in it is left out.
 */
export function activeCalls(
  voiceStates: ReadonlyMap<string, ReadonlyMap<string, VoiceState>>,
  channels: ReadonlyMap<string, Channel>,
  guilds: ReadonlyMap<string, Guild>,
  myId: string | null,
  myChannelId: string | null
): ActiveCall[] {
  const byChannel = new Map<string, VoiceState[]>()
  for (const states of voiceStates.values()) {
    for (const vs of states.values()) {
      if (!vs.channelId) continue
      const list = byChannel.get(vs.channelId)
      if (list) list.push(vs)
      else byChannel.set(vs.channelId, [vs])
    }
  }
  const calls: ActiveCall[] = []
  for (const [channelId, states] of byChannel) {
    const channel = channels.get(channelId)
    const guildId = states[0].guildId
    const guild = guildId ? guilds.get(guildId) : undefined // DM calls show in the DM, not here
    if (!channel || !guild || !guildId) continue
    const withMe = channelId === myChannelId
    if (!withMe && states.every((s) => s.userId === myId)) continue
    const ordered = [...states].sort((a, b) => joinTime(a) - joinTime(b))
    calls.push({
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channel.name ?? 'voice',
      userIds: ordered.map((s) => s.userId),
      streamerId: ordered.find((s) => s.selfStream && s.userId !== myId)?.userId ?? null,
      withMe
    })
  }
  return calls.sort(
    (a, b) =>
      Number(b.withMe) - Number(a.withMe) ||
      Number(b.streamerId !== null) - Number(a.streamerId !== null) ||
      b.userIds.length - a.userIds.length ||
      a.channelName.localeCompare(b.channelName)
  )
}

function joinTime(vs: VoiceState): number {
  return vs.joinedAt ? Date.parse(vs.joinedAt) : 0
}
