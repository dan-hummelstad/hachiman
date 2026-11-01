/**
 * Runtime events → Discord gateway dispatches. A dispatch whose payload depends on the intents of
 * a session (MESSAGE_CONTENT, GUILD_MEMBERS, GUILD_PRESENCES) gives a function of them.
 */
import type { BotMessage, ForwardedEvent } from '../runtime'
import type { BridgeRuntime } from './bridge'
import * as shape from './shapes'

type Json = Record<string, unknown>

export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
} as const

/** `intent`: the intent that a session needs for it; null for none. */
export type Emit = (t: string, d: Json | ((intents: number) => Json), intent: number | null) => void

const pick = (m: { guildId: string | null }, guild: number, dm: number): number => (m.guildId ? guild : dm)

/** Without GUILD_MEMBERS or GUILD_PRESENCES, Discord sends only the bot's own member and no presences. */
export function guildForIntents(g: Json, intents: number, meSnow: string): Json {
  return {
    ...g,
    members:
      intents & Intents.GUILD_MEMBERS
        ? g['members']
        : (g['members'] as { user: { id: string } }[]).filter(m => m.user.id === meSnow),
    presences: intents & Intents.GUILD_PRESENCES ? g['presences'] : [],
  }
}

export function wireDispatches(rt: BridgeRuntime, ctx: () => shape.ShapeContext, emit: Emit): void {
  const snow = (id: string): string => ctx().ids.snowflake(id)
  const meSnow = (): string => (rt.user ? snow(rt.user.id) : '')

  /** Discord hides guild message content without MESSAGE_CONTENT, except for mentions of the bot and its own messages. */
  const message = (m: BotMessage) => (intents: number) => {
    const me = rt.user?.id
    const visible =
      !m.guildId ||
      (intents & Intents.MESSAGE_CONTENT) !== 0 ||
      m.author.id === me ||
      m.mentions.some(x => x.type === 'user' && x.id === me)
    return shape.message(ctx(), m, { content: visible })
  }

  rt.on('message', m =>
    emit('MESSAGE_CREATE', message(m), pick(m, Intents.GUILD_MESSAGES, Intents.DIRECT_MESSAGES)),
  )
  rt.on('messageUpdate', m =>
    emit('MESSAGE_UPDATE', message(m), pick(m, Intents.GUILD_MESSAGES, Intents.DIRECT_MESSAGES)),
  )
  rt.on('messageDelete', d =>
    emit(
      'MESSAGE_DELETE',
      { id: snow(d.id), channel_id: snow(d.channelId), ...(d.guildId ? { guild_id: snow(d.guildId) } : {}) },
      pick(d, Intents.GUILD_MESSAGES, Intents.DIRECT_MESSAGES),
    ),
  )
  rt.on('reaction', r => {
    const m = r.guildId ? rt.cache.members.get(r.guildId)?.get(r.userId) : undefined
    emit(
      r.remove ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD',
      {
        user_id: snow(r.userId),
        channel_id: snow(r.channelId),
        message_id: snow(r.messageId),
        ...(r.guildId ? { guild_id: snow(r.guildId) } : {}),
        ...(m && !r.remove ? { member: shape.member(ctx(), m) } : {}),
        emoji: { id: null, name: r.emoji },
        burst: false,
        type: 0,
      },
      pick(r, Intents.GUILD_MESSAGE_REACTIONS, Intents.DIRECT_MESSAGE_REACTIONS),
    )
  })
  rt.on('event', e => forwarded(e))

  function forwarded(e: ForwardedEvent): void {
    const c = ctx()
    switch (e.t) {
      case 'GUILD_CREATE': {
        const g = shape.guildFull(c, e.d.id, rt.user?.id ?? null)
        if (g) emit(e.t, intents => guildForIntents(g, intents, meSnow()), Intents.GUILDS)
        return
      }
      case 'GUILD_UPDATE': {
        const roles = [...(rt.cache.roles.get(e.d.id)?.values() ?? [])]
        return emit(e.t, { ...shape.guildBase(c, e.d), roles: roles.map(r => shape.role(c, r)) }, Intents.GUILDS)
      }
      case 'GUILD_DELETE':
        return emit(e.t, { id: snow(e.d.id) }, Intents.GUILDS)
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'CHANNEL_DELETE': {
        const ch = shape.channel(c, e.d)
        if (!ch) return
        return emit(ch['type'] === 11 ? e.t.replace('CHANNEL', 'THREAD') : e.t, ch, e.d.guildId ? Intents.GUILDS : null)
      }
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
        return emit(e.t, { ...shape.member(c, e.d), guild_id: snow(e.d.guildId) }, Intents.GUILD_MEMBERS)
      case 'GUILD_MEMBER_REMOVE':
        return emit(e.t, { guild_id: snow(e.d.guildId), user: shape.user(c, e.d.user) }, Intents.GUILD_MEMBERS)
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
        return emit(e.t, { guild_id: snow(e.d.guildId), role: shape.role(c, e.d.role) }, Intents.GUILDS)
      case 'GUILD_ROLE_DELETE':
        return emit(e.t, { guild_id: snow(e.d.guildId), role_id: snow(e.d.roleId) }, Intents.GUILDS)
      case 'TYPING_START': {
        const x = e.d
        const m = x.guildId ? rt.cache.members.get(x.guildId)?.get(x.userId) : undefined
        return emit(
          e.t,
          {
            channel_id: snow(x.channelId),
            ...(x.guildId ? { guild_id: snow(x.guildId) } : {}),
            user_id: snow(x.userId),
            timestamp: Math.floor(Date.parse(x.timestamp) / 1000),
            ...(m ? { member: shape.member(c, m) } : {}),
          },
          pick(x, Intents.GUILD_MESSAGE_TYPING, Intents.DIRECT_MESSAGE_TYPING),
        )
      }
      case 'PRESENCE_UPDATE':
        for (const [guildId, members] of rt.cache.members)
          if (members.has(e.d.userId))
            emit(
              e.t,
              {
                user: { id: snow(e.d.userId) },
                guild_id: snow(guildId),
                status: e.d.status,
                activities: [],
                client_status: {},
              },
              Intents.GUILD_PRESENCES,
            )
        return
      case 'USER_UPDATE':
        return emit(e.t, { ...shape.user(c, e.d), bot: true }, null)
    }
  }
}
