/**
 * Hachiman entities → Discord API v10 objects, with every field that discord.js and discord.py read
 * (Discord's defaults where Hachiman has no such thing). Ids go through the IdMap. Hachiman uses
 * Discord's permission bit positions (pkgs/hachiman-client/src/permissions.ts) and Discord's
 * mention syntax in message text (`<@id>`, `<@&id>`, `<#id>`), so both pass through with only the
 * ids swapped.
 */
import type { Channel, ChannelType, Guild, HachimanCache, Member, Role, User } from '@hachiman/client'
import type { Mention } from '@hachiman/crypto'
import type { IdMap } from '../ids'
import type { BotMessage } from '../runtime'

export interface ShapeContext {
  ids: IdMap
  cache: HachimanCache
}

type Json = Record<string, unknown>

/** Discord channel types. Canvas and web channels have no chat: the bridge leaves them out. */
const CHANNEL_TYPES: Partial<Record<ChannelType, number>> = {
  text: 0,
  dm: 1,
  voice: 2,
  group_dm: 3,
  category: 4,
  pages: 0,
  thread: 11,
}

export function discordChannelType(t: ChannelType): number | null {
  return CHANNEL_TYPES[t] ?? null
}

export function user(ctx: ShapeContext, u: User): Json {
  return {
    id: ctx.ids.snowflake(u.id),
    username: u.username,
    discriminator: '0',
    global_name: u.username,
    avatar: null,
    bot: u.bot,
    system: false,
    flags: 0,
    public_flags: 0,
  }
}

export function role(ctx: ShapeContext, r: Role): Json {
  return {
    id: ctx.ids.snowflake(r.id),
    name: r.id === r.guildId ? '@everyone' : r.name,
    color: r.color,
    hoist: r.hoist,
    icon: null,
    unicode_emoji: null,
    position: r.position,
    permissions: String(r.permissions),
    managed: false,
    mentionable: true,
    flags: 0,
  }
}

export function member(ctx: ShapeContext, m: Member, withUser = true): Json {
  return {
    ...(withUser ? { user: user(ctx, m.user) } : {}),
    nick: m.nick,
    avatar: null,
    roles: m.roles.map(id => ctx.ids.snowflake(id)),
    joined_at: m.joinedAt,
    premium_since: null,
    deaf: m.deaf,
    mute: m.mute,
    flags: 0,
    pending: false,
    communication_disabled_until: null,
  }
}

export function channel(ctx: ShapeContext, c: Channel): Json | null {
  const type = discordChannelType(c.type)
  if (type === null) return null
  const base: Json = {
    id: ctx.ids.snowflake(c.id),
    type,
    last_message_id: null,
    flags: 0,
  }
  if (c.guildId === null) {
    return {
      ...base,
      recipients: (c.recipients ?? []).map(u => user(ctx, u)),
      ...(type === 3
        ? {
            name: c.name,
            icon: null,
            owner_id: c.ownerId ? ctx.ids.snowflake(c.ownerId) : null,
          }
        : {}),
    }
  }
  return {
    ...base,
    guild_id: ctx.ids.snowflake(c.guildId),
    name: c.name ?? '',
    topic: c.topic,
    position: c.position,
    parent_id: c.parentId ? ctx.ids.snowflake(c.parentId) : null,
    nsfw: false,
    rate_limit_per_user: 0,
    permission_overwrites: c.permissionOverwrites.map(o => ({
      id: ctx.ids.snowflake(o.id),
      type: o.type === 'role' ? 0 : 1,
      allow: String(o.allow),
      deny: String(o.deny),
    })),
    ...(type === 2 ? { bitrate: 64000, user_limit: 0, rtc_region: null } : {}),
    ...(type === 11
      ? {
          owner_id: c.ownerId ? ctx.ids.snowflake(c.ownerId) : null,
          message_count: 0,
          member_count: 0,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 10080,
            archive_timestamp: new Date(0).toISOString(),
            locked: false,
          },
        }
      : {}),
  }
}

export function guildBase(ctx: ShapeContext, g: Guild): Json {
  return {
    id: ctx.ids.snowflake(g.id, g.createdAt),
    name: g.name,
    icon: null,
    splash: null,
    discovery_splash: null,
    banner: null,
    description: null,
    owner_id: ctx.ids.snowflake(g.ownerId),
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: 0,
    default_message_notifications: 1,
    explicit_content_filter: 0,
    features: [],
    mfa_level: 0,
    application_id: null,
    system_channel_id: g.welcomeChannelId ? ctx.ids.snowflake(g.welcomeChannelId) : null,
    system_channel_flags: 0,
    rules_channel_id: null,
    public_updates_channel_id: null,
    safety_alerts_channel_id: null,
    vanity_url_code: null,
    premium_tier: 0,
    premium_subscription_count: 0,
    preferred_locale: 'en-US',
    nsfw_level: 0,
    premium_progress_bar_enabled: false,
    max_members: 500000,
    stickers: [],
    emojis: [],
  }
}

/** A guild from the client cache: the GUILD_CREATE and GET /guilds/:id shape. */
export function guildFull(ctx: ShapeContext, guildId: string, me: string | null): Json | null {
  const g = ctx.cache.guilds.get(guildId)
  if (!g) return null
  const roles = [...(ctx.cache.roles.get(guildId)?.values() ?? [])]
  const members = [...(ctx.cache.members.get(guildId)?.values() ?? [])]
  const channels = [...ctx.cache.channels.values()].filter(c => c.guildId === guildId)
  const own = me ? members.find(m => m.user.id === me) : undefined
  return {
    ...guildBase(ctx, g),
    roles: roles.map(r => role(ctx, r)),
    joined_at: own?.joinedAt ?? g.createdAt,
    large: false,
    unavailable: false,
    member_count: members.length,
    voice_states: [],
    members: members.map(m => member(ctx, m)),
    channels: channels.filter(c => c.type !== 'thread').flatMap(c => channel(ctx, c) ?? []),
    threads: channels.filter(c => c.type === 'thread').flatMap(c => channel(ctx, c) ?? []),
    presences: [...ctx.cache.presences.entries()]
      .filter(([userId]) => members.some(m => m.user.id === userId))
      .map(([userId, status]) => ({
        user: { id: ctx.ids.snowflake(userId) },
        status,
        activities: [],
        client_status: {},
      })),
    stage_instances: [],
    guild_scheduled_events: [],
    soundboard_sounds: [],
  }
}

const MENTION = /<(@!?|@&|#)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi
const DISCORD_MENTION = /<(@!?|@&|#)(\d{1,20})>/g

/** Hachiman text → Discord text: the UUIDs in mentions become snowflakes. */
export function textToDiscord(ctx: ShapeContext, text: string): string {
  return text.replace(
    MENTION,
    (_m, kind: string, id: string) => `<${kind === '@!' ? '@' : kind}${ctx.ids.snowflake(id)}>`,
  )
}

/**
 * Discord text → Hachiman text and its structured mentions (§12.8 MessageContent.mentions). A
 * snowflake that the bridge never gave out stays as it is and mentions nobody.
 */
export function textFromDiscord(ctx: ShapeContext, text: string): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = []
  const seen = new Set<string>()
  const add = (m: Mention): void => {
    const key = `${m.type}:${m.id ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      mentions.push(m)
    }
  }
  const out = text.replace(DISCORD_MENTION, (whole, kind: string, snow: string) => {
    const id = ctx.ids.uuid(snow)
    if (!id) return whole
    if (kind === '@&') add({ type: 'role', id })
    else if (kind !== '#') add({ type: 'user', id })
    return `<${kind === '@!' ? '@' : kind}${id}>`
  })
  if (/@everyone|@here/.test(out)) add({ type: 'everyone', id: null })
  return { text: out, mentions }
}

/** Discord embeds have no Hachiman form: they become markdown under the text. */
export function embedsToText(embeds: unknown): string {
  if (!Array.isArray(embeds)) return ''
  const parts: string[] = []
  for (const raw of embeds) {
    const e = (raw ?? {}) as {
      title?: string
      url?: string
      description?: string
      fields?: { name?: string; value?: string }[]
      footer?: { text?: string }
      author?: { name?: string }
    }
    const lines: string[] = []
    if (e.author?.name) lines.push(`*${e.author.name}*`)
    if (e.title) lines.push(e.url ? `**[${e.title}](${e.url})**` : `**${e.title}**`)
    if (e.description) lines.push(e.description)
    for (const f of e.fields ?? []) if (f.name || f.value) lines.push(`**${f.name ?? ''}**\n${f.value ?? ''}`)
    if (e.footer?.text) lines.push(`-# ${e.footer.text}`)
    if (lines.length > 0) parts.push(lines.map(l => `> ${l.replace(/\n/g, '\n> ')}`).join('\n'))
  }
  return parts.join('\n\n')
}

export function message(
  ctx: ShapeContext,
  m: BotMessage,
  opts: { content?: boolean; nonce?: unknown } = {},
): Json {
  const users = m.mentions.filter(x => x.type === 'user' && x.id).map(x => x.id as string)
  const members = m.guildId ? ctx.cache.members.get(m.guildId) : undefined
  const author = members?.get(m.author.id)
  return {
    id: ctx.ids.snowflake(m.id, m.createdAt),
    channel_id: ctx.ids.snowflake(m.channelId),
    ...(m.guildId ? { guild_id: ctx.ids.snowflake(m.guildId) } : {}),
    author: user(ctx, m.author),
    ...(author ? { member: member(ctx, author, false) } : {}),
    content: opts.content === false ? '' : textToDiscord(ctx, m.content),
    timestamp: m.createdAt,
    edited_timestamp: m.editedAt,
    tts: false,
    mention_everyone: m.mentions.some(x => x.type === 'everyone'),
    mentions: users.flatMap(id => {
      const mm = members?.get(id)
      const u = mm?.user ?? (ctx.cache.user?.id === id ? ctx.cache.user : null)
      return u
        ? [
            {
              ...user(ctx, u),
              ...(mm ? { member: member(ctx, mm, false) } : {}),
            },
          ]
        : []
    }),
    mention_roles: m.mentions
      .filter(x => x.type === 'role' && x.id)
      .map(x => ctx.ids.snowflake(x.id as string)),
    mention_channels: [],
    attachments: [],
    embeds: [],
    reactions: [],
    pinned: false,
    type: m.replyTo ? 19 : 0,
    flags: 0,
    components: [],
    ...(m.replyTo
      ? {
          message_reference: {
            type: 0,
            message_id: ctx.ids.snowflake(m.replyTo),
            channel_id: ctx.ids.snowflake(m.channelId),
            ...(m.guildId ? { guild_id: ctx.ids.snowflake(m.guildId) } : {}),
          },
        }
      : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  }
}
