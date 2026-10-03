// Preview stubs: replace every network seam of the one HachimanClient with local fakes that echo
// writes back as gateway dispatches, so the UI updates exactly as it would live. Messages go
// through the stub crypto client (createCryptoStub): envelopes are marked JSON, NOT ENCRYPTED.
import {
  DEFAULT_EVERYONE,
  DEFAULT_LIMITS,
  RestError,
  VoiceConnection,
  blobKey,
  type Attachment,
  type DocUpdate,
  type GatewayDispatch,
  type GuildFull,
  type Invite,
  type Message,
  type Page,
  type PermissionOverwrite,
  type VoiceE2eeDelegate,
  type VoiceStats
} from '@hachiman/client'
import { fromB64url } from '@hachiman/crypto'
import { hachiman } from '@/services/hachiman'
import { useMessageStore } from '@/stores/messagesStore'
import {
  DAY,
  G1,
  G1C,
  ME,
  QUALITY,
  U,
  channel,
  dms,
  groupOf,
  member,
  nextId,
  now,
  role,
  user,
  READY
} from './fixture'
import { fixturePages } from './fixture-pages'
import { previewFileUrl, uploaded } from './images'

export const dispatch = (e: GatewayDispatch): void => {
  hachiman.gateway.emit('dispatch', e)
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`[preview] unknown ${what}`)
  return value
}

/** No media, so no keys: the preview call never starts a crypto session. */
const NO_E2EE: VoiceE2eeDelegate = {
  start: () => Promise.reject(new Error('[preview] no media')),
  handle: () => Promise.resolve([]),
  senderTransform: () => {
    throw new Error('[preview] no media')
  },
  receiverTransform: () => {
    throw new Error('[preview] no media')
  },
  releaseTransform: () => {},
  close: () => {}
}

/** A real, never-connected VoiceConnection (inert: no socket, no peer connection) with fake stats. */
class PreviewVoiceConnection extends VoiceConnection {
  constructor() {
    super({ endpoint: '', token: '', iceServers: [], e2ee: NO_E2EE })
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
type AsyncKey = {
  [K in keyof Rest]: Rest[K] extends (...args: never[]) => Promise<unknown> ? K : never
}[keyof Rest]

/**
 * The §12.12 routes. Only the crypto Worker calls them, and the preview runs the stub crypto
 * client, which calls none. Each one rejects.
 */
const DS_ROUTES = [
  'registerDevice',
  'listDevices',
  'renameDevice',
  'putDeviceCertificate',
  'revokeDevice',
  'getUserKeys',
  'putMasterKey',
  'putDeviceSigningKey',
  'getDsInfo',
  'uploadKeyPackages',
  'countKeyPackages',
  'listMlsGroups',
  'getMlsGroup',
  'getChannelMlsGroup',
  'getMlsGroupState',
  'createMlsGroup',
  'postCommit',
  'getHandshakes',
  'postJoinRequest',
  'getJoinRequest',
  'declineBatch',
  'postHistoryBundle',
  'getHistoryBundles',
  'getInbox',
  'ackInbox',
  'postInbox',
  'getBackups',
  'putIdentityBackup',
  'postHistoryBackup',
  'getBackup',
  'deleteBackups',
  'createLinkSession',
  'listLinkSessions',
  'postLinkMessage',
  'getLinkMessages',
  'deleteLinkSession',
  'ktTreeHead',
  'ktInclusion',
  'ktConsistency',
  'ktEntries',
  'getAdminActions',
  'report'
] as const satisfies readonly AsyncKey[]

/**
 * One local implementation per other REST method. Keyed by the real client, so a renamed or new
 * method fails to compile here until it has a stub (or joins DS_ROUTES).
 */
type RestStubs = {
  [K in Exclude<AsyncKey, (typeof DS_ROUTES)[number]>]: Rest[K] extends (
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => R | Promise<R>
    : never
}

const INVITE_CODE = 'nt0wl5x'
const PREVIEW_DEVICE = READY.deviceId

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

/** A `data:` URL as a Blob, without fetch (the CSP connect-src has no data:). */
function dataUrlBlob(url: string): Blob | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (!m) return null
  const [, type, base64, body] = m
  if (!base64) return new Blob([decodeURIComponent(body ?? '')], { type })
  const bin = atob(body ?? '')
  return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type })
}

/** Renders an SVG data URL to a PNG Blob of its own size. */
async function svgToPng(url: string): Promise<Blob> {
  const img = new Image()
  img.src = url
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || 300
  canvas.height = img.naturalHeight || 150
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!png) throw new RestError(404, 'UnknownFile')
  return png
}

/** The client_msg_id inside a stub envelope (base64url JSON, see createCryptoStub). */
function stubClientMsgId(envelope: string): string {
  try {
    const v = JSON.parse(new TextDecoder().decode(fromB64url(envelope))) as {
      clientMsgId?: unknown
    }
    return typeof v.clientMsgId === 'string' ? v.clientMsgId : nextId('cmid')
  } catch {
    return nextId('cmid')
  }
}

/** Stub every REST call: resolve with a plausible value and mirror writes into the cache. */
export function stubRest(): void {
  const { cache } = hachiman
  /** Upload id → the Attachment it returned, so a sent message carries them. */
  const attachments = new Map<string, Attachment>()
  /** Blob key → the "encrypted" (stub: plain) blob that the preview uploaded. */
  const blobs = new Map<string, Blob>()
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
      publicHistoryVisibility: 'shared',
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
  /** A ciphertext row as Takusen stores it. The stub envelope stands in for the ciphertext. */
  const wire = (
    channelId: string,
    envelope: string,
    rows: Attachment[],
    base: Partial<Message> = {}
  ): Message => ({
    id: nextId('m'),
    channelId,
    guildId: cache.channels.get(channelId)?.guildId ?? null,
    author: ME,
    senderDevice: PREVIEW_DEVICE,
    groupId: groupOf(channelId),
    epoch: 3,
    clientMsgId: stubClientMsgId(envelope),
    attachments: rows,
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...base,
    envelope
  })

  // Pages (§4 Pages): in memory, seeded with the fixture pages. An update comes back as DOC_UPDATE
  // to this client too, so the panel works without a second tab.
  const seed = fixturePages()
  const pages = new Map<string, Page>(seed.pages.map((p) => [p.id, p]))
  const docUpdates = seed.updates
  const pageOf = (pageId: string): Page => {
    const p = pages.get(pageId)
    if (!p) throw new RestError(404, 'NotFound')
    return p
  }
  const pageGuild = (p: Page): string =>
    must(cache.channels.get(p.channelId)?.guildId ?? undefined, 'guild')

  const impl: RestStubs = {
    getPages: (channelId) => [...pages.values()].filter((p) => p.channelId === channelId),
    createPage: (channelId, body) => {
      const now = new Date().toISOString()
      const p: Page = { ...body, channelId, createdBy: ME.id, createdAt: now, updatedAt: now }
      pages.set(p.id, p)
      dispatch({ t: 'PAGE_CREATE', d: { ...p, guildId: pageGuild(p) } })
      return p
    },
    updatePage: (pageId, body) => {
      const p = pageOf(pageId)
      const next: Page = {
        ...p,
        parentId: body.parentId === undefined ? p.parentId : body.parentId,
        position: body.position ?? p.position,
        titleEnvelope: body.titleEnvelope ?? p.titleEnvelope,
        updatedAt: new Date().toISOString()
      }
      pages.set(pageId, next)
      dispatch({ t: 'PAGE_UPDATE', d: { ...next, guildId: pageGuild(next) } })
      return next
    },
    deletePage: (pageId) => {
      const p = pageOf(pageId)
      const ids = [pageId]
      for (let i = 0; i < ids.length; i++)
        for (const c of pages.values()) if (c.parentId === ids[i]) ids.push(c.id)
      for (const id of ids) pages.delete(id)
      dispatch({
        t: 'PAGE_DELETE',
        d: { id: pageId, channelId: p.channelId, guildId: pageGuild(p), ids }
      })
      return undefined
    },
    getPageState: (pageId) => {
      const updates = docUpdates.get(pageOf(pageId).id) ?? []
      return { snapshot: null, updates, latestSeq: updates.length }
    },
    getPageUpdates: (pageId, q) => {
      const updates = docUpdates.get(pageOf(pageId).id) ?? []
      return { updates: updates.filter((u) => u.seq > q.after), latestSeq: updates.length }
    },
    postPageUpdate: (pageId, body) => {
      const p = pageOf(pageId)
      const list = docUpdates.get(pageId) ?? []
      const u: DocUpdate = {
        pageId,
        seq: list.length + 1,
        groupId: groupOf(p.channelId),
        epoch: 3,
        senderDevice: PREVIEW_DEVICE,
        envelope: body.envelope,
        createdAt: new Date().toISOString()
      }
      docUpdates.set(pageId, [...list, u])
      dispatch({ t: 'DOC_UPDATE', d: { ...u, channelId: p.channelId, guildId: pageGuild(p) } })
      return { seq: u.seq }
    },
    postPageSnapshot: () => {
      throw new RestError(501, 'PreviewUnsupported', '[preview] page snapshots are not stored')
    },
    claimPageMedia: () => undefined,
    uploadSnapshot: (blob, opts) => impl.uploadBlob(blob, opts),
    getMe: () => ME,
    updateMe: (body) => {
      const me = must(cache.user ?? undefined, 'user')
      const u = { ...me, avatar: body.avatar === undefined ? me.avatar : body.avatar }
      dispatch({ t: 'USER_UPDATE', d: u })
      // As Takusen does: every guild of mine sees the change through my member.
      for (const members of cache.members.values()) {
        const m = members.get(u.id)
        if (m) dispatch({ t: 'GUILD_MEMBER_UPDATE', d: { ...m, user: u } })
      }
      return u
    },
    getLimits: () => DEFAULT_LIMITS,
    // The upload id doubles as its file key, so updateMe/updateGuild can store it as is.
    uploadImage: (file, opts) => {
      const id = `${nextId('up')}/${opts.filename}`
      uploaded.set(id, URL.createObjectURL(file))
      return fakeTransfer(file.size, opts.signal, opts.onProgress).then(() => ({
        id,
        key: id,
        size: file.size
      }))
    },
    uploadBlob: (blob, opts) => {
      const id = nextId('up')
      const a: Attachment = { id, key: blobKey(id), size: blob.size }
      attachments.set(id, a)
      blobs.set(a.key, blob)
      return fakeTransfer(blob.size, opts?.signal, opts?.onProgress).then(() => a)
    },
    fetchBlob: (key) => {
      const uploadedBlob = blobs.get(key)
      if (uploadedBlob) return uploadedBlob
      const url = previewFileUrl(key)
      // The fixture images are SVG, but their pointers say PNG (the stub keeps the pointer type).
      if (url.startsWith('data:image/svg+xml')) return svgToPng(url)
      const blob = dataUrlBlob(url)
      if (!blob) throw new RestError(404, 'UnknownFile')
      return blob
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
    // The fixture history is seeded into the store as decrypted rows; new channels start empty.
    getMessages: () => [],
    sendMessage: (channelId, body) => {
      const rows = (body.attachments ?? []).flatMap((id) => attachments.get(id) ?? [])
      const m = wire(channelId, body.envelope, rows, { nonce: body.nonce })
      return new Promise((r) => setTimeout(() => r(m), 400))
    },
    editMessage: (channelId, messageId, body) => {
      const old = must(
        useMessageStore
          .getState()
          .byChannel.get(channelId)
          ?.find((m) => m.id === messageId),
        'message'
      )
      // The upload rows stay (§12.8.4): per pointer, the file and then its thumbnail.
      const rows = old.attachments.flatMap((p) => [
        { id: p.uploadId, key: blobKey(p.uploadId), size: p.blobSize },
        ...(p.thumbnail
          ? [
              {
                id: p.thumbnail.uploadId,
                key: blobKey(p.thumbnail.uploadId),
                size: p.thumbnail.blobSize
              }
            ]
          : [])
      ])
      const m = wire(channelId, body.envelope, rows, {
        id: old.id,
        author: old.author,
        createdAt: old.createdAt,
        editedAt: new Date().toISOString()
      })
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
  for (const key of DS_ROUTES) {
    Object.defineProperty(hachiman.rest, key, {
      value: async () => {
        throw new RestError(501, 'PreviewUnsupported', `[preview] rest.${key} needs a real Takusen`)
      }
    })
  }
  Object.defineProperty(hachiman.rest, 'fileUrl', { value: previewFileUrl })
}
