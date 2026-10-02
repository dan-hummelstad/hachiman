// Preview stubs: replace every network seam of the one HachimanClient with local fakes that echo
// writes back as gateway dispatches, so the UI updates exactly as it would live.
import {
  DEFAULT_EVERYONE,
  DEFAULT_LIMITS,
  type Attachment,
  VoiceConnection,
  type GatewayDispatch,
  type GuildFull,
  type Invite,
  type Message,
  type PermissionOverwrite,
  type VoiceStats
} from '@hachiman/client'
import { hachiman } from '@/services/hachiman'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import {
  DAY,
  G1,
  G1C,
  ME,
  QUALITY,
  U,
  channel,
  dms,
  member,
  nextId,
  now,
  role,
  user,
  READY
} from './fixture'
import { previewFileUrl, uploaded } from './images'

export const dispatch = (e: GatewayDispatch): void => {
  hachiman.gateway.emit('dispatch', e)
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`[preview] unknown ${what}`)
  return value
}

/** A real, never-connected VoiceConnection (inert: no socket, no peer connection) with fake stats. */
class PreviewVoiceConnection extends VoiceConnection {
  constructor() {
    super({ endpoint: '', token: '', iceServers: [] })
  }
  override async getStats(): Promise<VoiceStats> {
    const { rttMs, jitterMs, packetLoss } = QUALITY()
    return { rttMs, jitterMs, packetLoss }
  }
}

/**
 * Voice without media. Join/leave and self mute/deafen echo a VOICE_STATE_UPDATE for me. The
 * mute/deafen policy stays the client's own `setSelfVoice` (it only skips the wire send here,
 * because the stubbed join never sets the client's voice target).
 */
export function stubVoice(): void {
  let current: { guildId: string; channelId: string } | null = {
    guildId: G1,
    channelId: G1C.lounge
  }
  const sendState = (guildId: string, channelId: string | null): void => {
    const { selfMute, selfDeaf } = hachiman.selfVoice
    dispatch({
      t: 'VOICE_STATE_UPDATE',
      d: {
        guildId,
        channelId,
        userId: ME.id,
        sessionId: 'preview-voice',
        selfMute,
        selfDeaf,
        selfStream: false
      }
    })
  }

  hachiman.joinVoice = async (guildId, channelId) => {
    current = { guildId, channelId }
    sendState(guildId, channelId)
    const conn = new PreviewVoiceConnection()
    setTimeout(() => conn.emit('state', 'connected'), 300)
    return conn
  }
  hachiman.leaveVoice = () => {
    if (current) sendState(current.guildId, null)
    current = null
  }
  const setSelfVoice = hachiman.setSelfVoice.bind(hachiman)
  hachiman.setSelfVoice = (change) => {
    const next = setSelfVoice(change)
    if (current) sendState(current.guildId, current.channelId)
    return next
  }
}

type Rest = typeof hachiman.rest
/** One local implementation per REST method. Keyed by the real client, so a renamed or new method fails to compile here. */
type RestStubs = {
  [
    K in keyof Rest as Rest[K] extends (...args: never[]) => Promise<unknown> ? K : never
  ]: Rest[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R | Promise<R> : never
}

const INVITE_CODE = 'nt0wl5x'

/** About 2 s of upload progress in ticks, so the composer tray's progress bar shows. */
function fakeTransfer(
  total: number,
  signal: AbortSignal | undefined,
  onProgress: ((loaded: number, total: number) => void) | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    let step = 0
    const timer = setInterval(() => {
      step++
      onProgress?.(Math.round((total * step) / 10), total)
      if (step === 10) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
    signal?.addEventListener('abort', () => {
      clearInterval(timer)
      reject(new DOMException('Upload aborted', 'AbortError'))
    })
  })
}

/** Stub every REST call: resolve with a plausible value and mirror writes into the cache. */
export function stubRest(history: Map<string, ChatMessage[]>): void {
  const { cache } = hachiman
  /** Upload id → the Attachment it returned, so a sent message carries them. */
  const attachments = new Map<string, Attachment>()
  const invite = (guildId: string): Invite => ({
    code: INVITE_CODE,
    guildId,
    createdBy: ME.id,
    expiresAt: new Date(now + 7 * DAY).toISOString(),
    maxUses: null,
    uses: 3,
    createdAt: new Date(now - DAY).toISOString()
  })
  const createGuild = (name: string): GuildFull => {
    const id = nextId('g')
    const g: GuildFull = {
      id,
      name,
      icon: null,
      banner: null,
      ownerId: ME.id,
      region: null,
      createdAt: new Date().toISOString(),
      channels: [
        channel(id, nextId('c'), 'text', 'general', 0),
        channel(id, nextId('c'), 'voice', 'General', 0)
      ],
      roles: [role(id, id, '@everyone', 0, 0, DEFAULT_EVERYONE)],
      members: [member(id, ME, [], null, 0)],
      voiceStates: [],
      presences: [{ userId: ME.id, status: 'online' }]
    }
    dispatch({ t: 'GUILD_CREATE', d: g })
    return g
  }
  /** Replace `targetId`'s overwrite on a channel with whatever `next` returns. */
  const updateOverwrites = (
    channelId: string,
    targetId: string,
    next: (others: PermissionOverwrite[]) => PermissionOverwrite[]
  ): void => {
    const c = must(cache.channels.get(channelId), 'channel')
    const others = c.permissionOverwrites.filter((o) => o.id !== targetId)
    dispatch({ t: 'CHANNEL_UPDATE', d: { ...c, permissionOverwrites: next(others) } })
  }

  const impl: RestStubs = {
    getMe: () => ME,
    updateMe: (body) => {
      const me = must(cache.user ?? undefined, 'user')
      const u = { ...me, avatar: body.avatar === undefined ? me.avatar : body.avatar }
      dispatch({ t: 'USER_UPDATE', d: u })
      // As Oracle does: every guild of mine sees the change through my member.
      for (const members of cache.members.values()) {
        const m = members.get(u.id)
        if (m) dispatch({ t: 'GUILD_MEMBER_UPDATE', d: { ...m, user: u } })
      }
      return u
    },
    getLimits: () => DEFAULT_LIMITS,
    // The upload id doubles as its file key, so updateMe/updateGuild can store it as is.
    upload: (file, opts) => {
      const id = `${nextId('up')}/${opts.filename}`
      uploaded.set(id, URL.createObjectURL(file))
      const a: Attachment = {
        id,
        key: id,
        filename: opts.filename,
        size: file.size,
        contentType: file.type,
        width: opts.width ?? null,
        height: opts.height ?? null
      }
      attachments.set(id, a)
      return fakeTransfer(file.size, opts.signal, opts.onProgress).then(() => a)
    },
    getUser: (id) => Object.values(U).find((u) => u.id === id) ?? ME,
    createGuild: (body) => createGuild(body.name),
    getGuild: (id) =>
      must(
        READY.guilds.find((g) => g.id === id),
        'guild'
      ),
    updateGuild: (id, body) => {
      const g = { ...must(cache.guilds.get(id), 'guild'), ...body }
      dispatch({ t: 'GUILD_UPDATE', d: g })
      return g
    },
    deleteGuild: (id) => {
      dispatch({ t: 'GUILD_DELETE', d: { id } })
    },
    createChannel: (guildId, body) => {
      const c = channel(guildId, nextId('c'), body.type, body.name, 99, {
        parentId: body.parentId ?? null,
        topic: body.topic ?? null
      })
      dispatch({ t: 'CHANNEL_CREATE', d: c })
      return c
    },
    reorderChannels: () => undefined,
    updateChannel: (id, body) => {
      const c = { ...must(cache.channels.get(id), 'channel'), ...body }
      dispatch({ t: 'CHANNEL_UPDATE', d: c })
      return c
    },
    deleteChannel: (id) => {
      const c = cache.channels.get(id)
      if (c) dispatch({ t: 'CHANNEL_DELETE', d: c })
    },
    putOverwrite: (channelId, targetId, body) => {
      updateOverwrites(channelId, targetId, (others) => [...others, { id: targetId, ...body }])
    },
    deleteOverwrite: (channelId, targetId) => {
      updateOverwrites(channelId, targetId, (others) => others)
    },
    getMessages: (channelId) => (history.get(channelId) ?? []).filter((m) => !m.pending),
    sendMessage: (channelId, body) => {
      const m: Message = {
        id: nextId('m'),
        channelId,
        guildId: cache.channels.get(channelId)?.guildId ?? null,
        author: ME,
        content: body.content,
        createdAt: new Date().toISOString(),
        editedAt: null,
        attachments: (body.attachments ?? []).flatMap((id) => attachments.get(id) ?? []),
        nonce: body.nonce
      }
      return new Promise((r) => setTimeout(() => r(m), 400))
    },
    editMessage: (channelId, messageId, body) => {
      const old = useMessageStore
        .getState()
        .byChannel.get(channelId)
        ?.find((m) => m.id === messageId)
      const m: Message = {
        ...must(old, 'message'),
        content: body.content,
        editedAt: new Date().toISOString()
      }
      dispatch({ t: 'MESSAGE_UPDATE', d: m })
      return m
    },
    deleteMessage: (channelId, messageId) => {
      dispatch({ t: 'MESSAGE_DELETE', d: { id: messageId, channelId, guildId: null } })
    },
    triggerTyping: () => undefined,
    getMembers: (guildId) => [...(cache.members.get(guildId)?.values() ?? [])],
    updateMember: (guildId, userId, body) => {
      const m = { ...must(cache.members.get(guildId)?.get(userId), 'member'), ...body }
      dispatch({ t: 'GUILD_MEMBER_UPDATE', d: m })
      return m
    },
    kickMember: (guildId, userId) => {
      const m = cache.members.get(guildId)?.get(userId)
      if (m) dispatch({ t: 'GUILD_MEMBER_REMOVE', d: { guildId, user: m.user } })
    },
    leaveGuild: (id) => {
      dispatch({ t: 'GUILD_DELETE', d: { id } })
    },
    getRoles: (guildId) => [...(cache.roles.get(guildId)?.values() ?? [])],
    createRole: (guildId, body) => {
      const r = role(
        guildId,
        nextId('r'),
        body.name ?? 'new role',
        body.color ?? 0x99a0ac,
        cache.roles.get(guildId)?.size ?? 1,
        body.permissions ?? 0
      )
      dispatch({ t: 'GUILD_ROLE_CREATE', d: { guildId, role: r } })
      return r
    },
    reorderRoles: (guildId, body) => {
      for (const { id, position } of body) {
        const r = cache.roles.get(guildId)?.get(id)
        if (r) dispatch({ t: 'GUILD_ROLE_UPDATE', d: { guildId, role: { ...r, position } } })
      }
      return [...(cache.roles.get(guildId)?.values() ?? [])]
    },
    updateRole: (guildId, roleId, body) => {
      const r = { ...must(cache.roles.get(guildId)?.get(roleId), 'role'), ...body }
      dispatch({ t: 'GUILD_ROLE_UPDATE', d: { guildId, role: r } })
      return r
    },
    deleteRole: (guildId, roleId) => {
      dispatch({ t: 'GUILD_ROLE_DELETE', d: { guildId, roleId } })
    },
    getInvites: (guildId) => [invite(guildId)],
    createInvite: (guildId) => invite(guildId),
    deleteInvite: () => undefined,
    previewInvite: (code) => ({
      code,
      guild: { id: 'g-preview-invite', name: 'Pixel Pushers', icon: null },
      memberCount: 48,
      expiresAt: null
    }),
    acceptInvite: (code) => createGuild(`Joined via ${code}`),
    getDmChannels: () => dms,
    openDm: (recipientIds) => {
      const existing = [...cache.channels.values()].find(
        (c) =>
          c.guildId === null && c.recipients?.length === 1 && c.recipients[0].id === recipientIds[0]
      )
      if (existing) return existing
      const u =
        Object.values(U).find((x) => x.id === recipientIds[0]) ?? user(recipientIds[0], 'someone')
      const c = channel(null, nextId('c-dm'), 'dm', null, 0, { recipients: [u] })
      dispatch({ t: 'CHANNEL_CREATE', d: c })
      return c
    }
  }

  for (const key of Object.keys(impl) as (keyof RestStubs)[]) {
    // The table is typed per key above; here every entry is called the same way.
    const fn = impl[key] as (...args: unknown[]) => unknown
    Object.defineProperty(hachiman.rest, key, {
      value: async (...args: unknown[]) => {
        console.debug('[preview] rest.%s', key, args)
        return fn(...args)
      }
    })
  }
  Object.defineProperty(hachiman.rest, 'fileUrl', { value: previewFileUrl })
}
