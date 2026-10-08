import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HachimanClient } from './client'
import { VoiceConnection } from './voice'
import { Permissions as P } from './permissions'
import { fakeDelegate, type FakeDelegate } from './test/fake-rtc'
import { FakeWebSocket, installFakeWebSocket } from './test/fake-ws'
import type { Channel, GuildEventWithMe, GuildFull, Member, Message, ReadyPayload, User } from './types'

const me: User = { id: 'me', username: 'me', avatar: null }
const bob: User = { id: 'bob', username: 'bob', avatar: null }
const member = (user: User, roles: string[] = []): Member => ({
  guildId: 'g',
  user,
  nick: null,
  roles,
  joinedAt: '',
})
const channel = (id: string, over: Partial<Channel> = {}): Channel => ({
  id,
  guildId: 'g',
  type: 'text',
  name: id,
  topic: null,
  parentId: null,
  position: 0,
  permissionOverwrites: [],
  mlsGroupId: null,
  historyVisibility: 'shared',
  ...over,
})
const guild: GuildFull = {
  id: 'g',
  name: 'G',
  icon: null,
  banner: null,
  ownerId: 'bob',
  region: null,
  createdAt: '',
  publicHistoryVisibility: 'shared',
  channels: [
    channel('general'),
    channel('secret', { permissionOverwrites: [{ id: 'g', type: 'role', allow: 0, deny: P.VIEW_CHANNEL }] }),
  ],
  roles: [
    {
      id: 'g',
      guildId: 'g',
      name: '@everyone',
      color: 0,
      hoist: false,
      position: 0,
      permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES,
    },
  ],
  members: [member(me), member(bob)],
  voiceStates: [
    {
      guildId: 'g',
      channelId: 'vc',
      userId: 'bob',
      sessionId: 'x',
      selfMute: false,
      selfDeaf: false,
      selfStream: false,
    },
  ],
  presences: [{ userId: 'bob', status: 'online' }],
}
const readyPayload: ReadyPayload = {
  v: 1,
  sessionId: 'S',
  deviceId: 'dev1',
  user: me,
  guilds: [guild],
  privateChannels: [channel('dm', { guildId: null, type: 'dm', name: null })],
  presences: [],
  readStates: [
    { channelId: 'general', lastReadMessageId: 'm1', unreadCount: 3, lastMessageId: 'm4' },
    { channelId: 'dm', lastReadMessageId: null, unreadCount: 0, lastMessageId: null },
  ],
}

const device = { deviceId: 'dev1', capabilities: ['e2ee/1'], clientVersion: '1.0.0' }

describe('HachimanClient cache', () => {
  let client: HachimanClient
  let ws: FakeWebSocket
  let seq = 0
  let delegates: FakeDelegate[] = []
  const dispatch = (t: string, d: unknown) => {
    ws.recv({ op: 0, s: ++seq, t, d })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    installFakeWebSocket()
    delegates = []
    client = new HachimanClient({
      apiUrl: 'http://api',
      gatewayUrl: 'ws://gw',
      getToken: () => Promise.resolve('t'),
      device: () => device,
      voiceE2ee: () => {
        const d = fakeDelegate()
        delegates.push(d)
        return d
      },
    })
    client.connect()
    ws = FakeWebSocket.last
    ws.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await vi.advanceTimersByTimeAsync(0)
    dispatch('READY', readyPayload)
  })
  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  it('READY populates every map', () => {
    const c = client.cache
    expect(c.user).toEqual(me)
    expect(c.guilds.get('g')).toEqual({
      id: 'g',
      name: 'G',
      icon: null,
      banner: null,
      ownerId: 'bob',
      region: null,
      createdAt: '',
      publicHistoryVisibility: 'shared',
    })
    expect([...c.channels.keys()].sort()).toEqual(['dm', 'general', 'secret'])
    expect(c.members.get('g')?.size).toBe(2)
    expect(c.presences.get('bob')).toBe('online')
    expect(c.voiceStates.get('g')?.get('bob')?.channelId).toBe('vc')
    expect(client.permissionsFor('general')).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES)
    expect(client.permissionsFor('secret')).toBe(0)
    expect(client.permissionsFor('dm')).toBe(
      P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.READ_MESSAGE_HISTORY,
    )
  })

  it('READY fills readStates and READ_STATE_UPDATE moves the read state forward', () => {
    const r = client.cache.readStates
    expect(r.get('general')).toEqual({ channelId: 'general', lastReadMessageId: 'm1', unreadCount: 3, lastMessageId: 'm4' })
    dispatch('READ_STATE_UPDATE', { channelId: 'general', lastReadMessageId: 'm4' })
    expect(r.get('general')).toEqual({ channelId: 'general', lastReadMessageId: 'm4', unreadCount: 0, lastMessageId: 'm4' })
    dispatch('READ_STATE_UPDATE', { channelId: 'dm', lastReadMessageId: 'd1' })
    expect(r.get('dm')).toEqual({ channelId: 'dm', lastReadMessageId: 'd1', unreadCount: 0, lastMessageId: 'd1' })
    dispatch('CHANNEL_DELETE', channel('general'))
    expect(r.has('general')).toBe(false)
    dispatch('READY', { ...readyPayload, readStates: [] })
    expect(r.size).toBe(0)
  })

  it('after a RESUME it leaves a call of this session that the client dropped, before state ready', async () => {
    const state = { guildId: 'g', channelId: 'vc', userId: 'me', sessionId: 'S', selfMute: false, selfDeaf: false, selfStream: false }
    dispatch('VOICE_STATE_UPDATE', state) // the server still has the call; the client left while offline
    ws.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws)
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await vi.advanceTimersByTimeAsync(0)
    let sentAtReady = 0
    client.on('state', s => {
      if (s === 'ready') sentAtReady = ws2.sent.length
    })
    ws2.recv({ op: 0, s: ++seq, t: 'RESUMED', d: {} })
    const leave = ws2.sent.findIndex(f => f.op === 4)
    expect(ws2.sent[leave]).toMatchObject({ op: 4, d: { guildId: 'g', channelId: null } })
    expect(leave).toBeLessThan(sentAtReady)
  })

  it('CHANNEL_UPDATE replaces the channel before re-emitting', () => {
    const seen = vi.fn(() => client.permissionsFor('secret'))
    client.on('CHANNEL_UPDATE', seen)
    dispatch('CHANNEL_UPDATE', channel('secret'))
    expect(seen).toHaveReturnedWith(P.VIEW_CHANNEL | P.SEND_MESSAGES)
  })

  it('GUILD_MEMBER_REMOVE drops the member', () => {
    const update = vi.fn()
    client.on('update', update)
    dispatch('GUILD_MEMBER_REMOVE', { guildId: 'g', user: bob })
    expect(client.cache.members.get('g')?.has('bob')).toBe(false)
    expect(update).toHaveBeenCalledWith({ t: 'GUILD_MEMBER_REMOVE', d: { guildId: 'g', user: bob } })
  })

  it('USER_UPDATE replaces the current user before re-emitting', () => {
    const next = { ...me, avatar: 'u1/a.png' }
    const seen = vi.fn(() => client.cache.user)
    client.on('USER_UPDATE', seen)
    dispatch('USER_UPDATE', next)
    expect(seen).toHaveReturnedWith(next)
  })

  it('GUILD_MEMBER_UPDATE replaces the member user; GUILD_UPDATE carries the banner', () => {
    dispatch('GUILD_MEMBER_UPDATE', member({ ...bob, avatar: 'u2/b.png' }))
    expect(client.cache.members.get('g')?.get('bob')?.user.avatar).toBe('u2/b.png')
    const { id, name, icon, ownerId, region, createdAt } = guild
    dispatch('GUILD_UPDATE', {
      id,
      name,
      icon,
      banner: 'u3/banner.webp',
      ownerId,
      region,
      createdAt,
      publicHistoryVisibility: 'joined',
    })
    expect(client.cache.guilds.get('g')?.banner).toBe('u3/banner.webp')
    expect(client.cache.guilds.get('g')?.publicHistoryVisibility).toBe('joined')
  })

  it('MESSAGE_CREATE is re-emitted as ciphertext (messages are not cached or decrypted)', () => {
    const msg = vi.fn()
    client.on('MESSAGE_CREATE', msg)
    const m: Message = {
      id: 'm1',
      channelId: 'general',
      guildId: 'g',
      author: bob,
      senderDevice: 'devB',
      groupId: 'Z3JvdXA',
      epoch: 3,
      clientMsgId: 'AAAAAAAAAAAAAAAAAAAAAA',
      envelope: 'SAE',
      attachments: [{ id: 'u1', key: 'u1/blob', size: 70000 }],
      createdAt: '',
      editedAt: null,
      nonce: 'n',
    }
    dispatch('MESSAGE_CREATE', m)
    expect(msg).toHaveBeenCalledWith(m)
  })

  it('re-emits the §12.13 events without touching the cache', () => {
    const batch = vi.fn()
    client.on('MLS_BATCH_ASSIGN', batch)
    const d = {
      batchId: 'b',
      groupId: 'g1',
      epoch: 2,
      proposals: [],
      joins: [],
      create: null,
      historyBundleEpochs: [],
      deadline: '',
    }
    dispatch('MLS_BATCH_ASSIGN', d)
    expect(batch).toHaveBeenCalledWith(d)
    expect(client.cache.guilds.size).toBe(1)
  })

  it('re-emits INVITE_DELETE without touching the cache', () => {
    const revoked = vi.fn()
    client.on('INVITE_DELETE', revoked)
    const d = { guildId: 'g', code: 'ABCDEFGH', inviteId: 'i1' }
    dispatch('INVITE_DELETE', d)
    expect(revoked).toHaveBeenCalledWith(d)
    expect(client.cache.guilds.size).toBe(1)
  })

  it('caches custom statuses and voice joinedAt', () => {
    const c = client.cache
    expect(c.customStatuses.size).toBe(0)
    const cs = { text: 'Reading chapter 6', expiresAt: null }
    dispatch('PRESENCE_UPDATE', { userId: 'bob', status: 'idle', customStatus: cs })
    expect(c.presences.get('bob')).toBe('idle')
    expect(c.customStatuses.get('bob')).toEqual(cs)
    dispatch('PRESENCE_UPDATE', { userId: 'bob', status: 'online' })
    expect(c.customStatuses.has('bob')).toBe(false)
    dispatch('PRESENCE_UPDATE', { userId: 'bob', status: 'dnd', customStatus: cs })
    dispatch('PRESENCE_UPDATE', { userId: 'bob', status: 'offline', customStatus: cs })
    expect(c.customStatuses.has('bob')).toBe(false)

    dispatch('VOICE_STATE_UPDATE', {
      guildId: 'g',
      channelId: 'vc',
      userId: 'bob',
      sessionId: 'x',
      selfMute: true,
      selfDeaf: false,
      selfStream: false,
      joinedAt: '2026-10-07T12:00:00Z',
    })
    expect(c.voiceStates.get('g')?.get('bob')?.joinedAt).toBe('2026-10-07T12:00:00Z')

    dispatch('READY', {
      ...readyPayload,
      guilds: [{ ...guild, presences: [{ userId: 'bob', status: 'online', customStatus: cs }] }],
      presences: [{ userId: 'dmpal', status: 'idle', customStatus: { text: 'away', expiresAt: '2026-10-08T00:00:00Z' } }],
    })
    expect(c.customStatuses.get('bob')).toEqual(cs)
    expect(c.customStatuses.get('dmpal')?.text).toBe('away')
  })

  it('setCustomStatus sends op 3', () => {
    client.setCustomStatus('5am, watching the VOD')
    expect(ws.sent.at(-1)).toEqual({ op: 3, d: { customStatus: { text: '5am, watching the VOD', expiresAt: null } } })
    client.setCustomStatus('')
    expect(ws.sent.at(-1)).toEqual({ op: 3, d: { customStatus: null } })
  })

  it('guild events: fetch fills the cache, the GUILD_EVENT_* events keep it, me follows own RSVPs', async () => {
    const ev = {
      id: 'e1',
      guildId: 'g',
      channelId: null,
      title: 'Scrims',
      startsAt: '2026-10-08T21:00:00.000Z',
      endsAt: null,
      createdBy: 'bob',
      createdAt: '',
      rsvpCount: 1,
    }
    vi.spyOn(client.rest, 'getGuildEvents').mockResolvedValue([{ ...ev, me: false }])
    await client.fetchGuildEvents('g')
    const events = () => client.cache.events.get('g')
    expect(events()?.get('e1')?.rsvpCount).toBe(1)

    dispatch('GUILD_EVENT_RSVP', { eventId: 'e1', guildId: 'g', userId: 'me', going: true, rsvpCount: 2 })
    expect(events()?.get('e1')).toMatchObject({ rsvpCount: 2, me: true })
    dispatch('GUILD_EVENT_RSVP', { eventId: 'e1', guildId: 'g', userId: 'bob', going: false, rsvpCount: 1 })
    expect(events()?.get('e1')).toMatchObject({ rsvpCount: 1, me: true })
    dispatch('GUILD_EVENT_UPDATE', { ...ev, title: 'Finals' })
    expect(events()?.get('e1')).toMatchObject({ title: 'Finals', me: true })
    dispatch('GUILD_EVENT_CREATE', { ...ev, id: 'e2', rsvpCount: 0 })
    expect(events()?.get('e2')?.me).toBe(false)
    dispatch('GUILD_EVENT_DELETE', { id: 'e1', guildId: 'g' })
    expect([...(events()?.keys() ?? [])]).toEqual(['e2'])
    // Not loaded for this guild: nothing to keep.
    dispatch('GUILD_EVENT_CREATE', { ...ev, guildId: 'other' })
    expect(client.cache.events.has('other')).toBe(false)
    dispatch('GUILD_DELETE', { id: 'g' })
    expect(client.cache.events.has('g')).toBe(false)
  })

  it('a guild events list that arrives after GUILD_DELETE or READY does not fill the cache', async () => {
    let resolve: (v: GuildEventWithMe[]) => void = () => {}
    vi.spyOn(client.rest, 'getGuildEvents').mockImplementation(
      () => new Promise<GuildEventWithMe[]>(r => (resolve = r)),
    )
    const gone = client.fetchGuildEvents('g')
    dispatch('GUILD_DELETE', { id: 'g' })
    resolve([])
    await gone
    expect(client.cache.events.has('g')).toBe(false)

    let resolveBlocks: (v: { user: User; createdAt: string }[]) => void = () => {}
    vi.spyOn(client.rest, 'getBlocks').mockImplementation(() => new Promise(r => (resolveBlocks = r)))
    const stale = client.fetchBlocks()
    dispatch('READY', readyPayload)
    resolveBlocks([{ user: bob, createdAt: '' }])
    expect(await stale).toEqual([{ user: bob, createdAt: '' }])
    expect(client.cache.blocks.size).toBe(0)
  })

  it('blocks: fetch fills the set, USER_BLOCK_UPDATE keeps it, READY clears it', async () => {
    vi.spyOn(client.rest, 'getBlocks').mockResolvedValue([{ user: bob, createdAt: '' }])
    expect(await client.fetchBlocks()).toEqual([{ user: bob, createdAt: '' }])
    expect([...client.cache.blocks]).toEqual(['bob'])
    dispatch('USER_BLOCK_UPDATE', { userId: 'bob', blocked: false })
    dispatch('USER_BLOCK_UPDATE', { userId: 'carol', blocked: true })
    expect([...client.cache.blocks]).toEqual(['carol'])
    dispatch('READY', readyPayload)
    expect(client.cache.blocks.size).toBe(0)
  })

  it('re-emits CHANNEL_PINS_UPDATE without caching pins', () => {
    const pins = vi.fn()
    client.on('CHANNEL_PINS_UPDATE', pins)
    dispatch('CHANNEL_PINS_UPDATE', { channelId: 'general', guildId: 'g' })
    expect(pins).toHaveBeenCalledWith({ channelId: 'general', guildId: 'g' })
  })

  it('roles, presence, voice state and guild delete', () => {
    dispatch('GUILD_ROLE_CREATE', {
      guildId: 'g',
      role: { id: 'r', guildId: 'g', name: 'r', color: 0, position: 1, permissions: P.ADMINISTRATOR },
    })
    dispatch('GUILD_MEMBER_UPDATE', member(me, ['r']))
    expect(client.permissionsFor('secret')).not.toBe(0)
    dispatch('GUILD_ROLE_DELETE', { guildId: 'g', roleId: 'r' })
    expect(client.cache.members.get('g')?.get('me')?.roles).toEqual([])
    dispatch('PRESENCE_UPDATE', { userId: 'bob', status: 'offline' })
    expect(client.cache.presences.has('bob')).toBe(false)
    dispatch('VOICE_STATE_UPDATE', {
      guildId: 'g',
      channelId: null,
      userId: 'bob',
      sessionId: 'x',
      selfMute: false,
      selfDeaf: false,
      selfStream: false,
    })
    expect(client.cache.voiceStates.get('g')?.has('bob')).toBe(false)
    dispatch('GUILD_DELETE', { id: 'g' })
    expect(client.cache.guilds.size).toBe(0)
    expect([...client.cache.channels.keys()]).toEqual(['dm'])
  })

  it('joinVoice sends op 4 and waits for the matching VOICE_SERVER_UPDATE', async () => {
    client.setSelfVoice({ selfMute: true })
    const p = client.joinVoice('g', 'vc')
    expect(ws.sent.at(-1)).toEqual({
      op: 4,
      d: { selfMute: true, selfDeaf: false, selfStream: false, guildId: 'g', channelId: 'vc' },
    })
    client.leaveVoice()
    await expect(p).rejects.toThrow('superseded')
    expect(ws.sent.at(-1)).toEqual({
      op: 4,
      d: { selfMute: true, selfDeaf: false, selfStream: false, guildId: 'g', channelId: null },
    })
  })

  it('DM calls: states keyed by the DM channel, CALL_RING re-emitted, join and leave with guildId null', async () => {
    const dmState = {
      guildId: null,
      channelId: 'dm',
      userId: 'bob',
      sessionId: 'x',
      selfMute: false,
      selfDeaf: false,
      selfStream: false,
    }
    dispatch('READY', { ...readyPayload, privateVoiceStates: [dmState] })
    expect(client.cache.voiceStates.get('dm')?.get('bob')).toEqual(dmState)
    const rings: unknown[] = []
    client.on('CALL_RING', (d) => rings.push(d))
    const ring = { channelId: 'dm', userId: 'bob', ringing: ['me'], at: '2026-10-08T00:00:00Z' }
    dispatch('CALL_RING', ring)
    expect(rings).toEqual([ring])
    dispatch('VOICE_STATE_UPDATE', { ...dmState, channelId: null })
    expect(client.cache.voiceStates.get('dm')?.has('bob')).toBe(false)

    const p = client.joinVoice(null, 'dm')
    expect(ws.sent.at(-1)).toEqual({
      op: 4,
      d: { selfMute: false, selfDeaf: false, selfStream: false, guildId: null, channelId: 'dm' },
    })
    client.leaveVoice()
    await expect(p).rejects.toThrow('superseded')
    expect(ws.sent.at(-1)?.d).toMatchObject({ guildId: null, channelId: null })
  })

  describe('setSelfVoice', () => {
    const voiceFrames = () => ws.sent.filter(f => f.op === 4)
    // Keeps a join pending (no VOICE_SERVER_UPDATE), so the client is "in voice" on the gateway.
    const startJoin = () => {
      client.joinVoice('g', 'vc').catch(() => undefined)
    }

    it('outside voice sends nothing; the next join uses it', () => {
      expect(client.setSelfVoice({ selfDeaf: true })).toEqual({
        ownMute: false,
        selfMute: true,
        selfDeaf: true,
      })
      expect(voiceFrames()).toHaveLength(0)
      startJoin()
      expect(voiceFrames()).toEqual([
        { op: 4, d: { selfMute: true, selfDeaf: true, selfStream: false, guildId: 'g', channelId: 'vc' } },
      ])
    })

    it('sends exactly one frame per change; deafen implies mute', () => {
      startJoin()
      const before = voiceFrames().length
      client.setSelfVoice({ selfDeaf: true })
      expect(voiceFrames().slice(before)).toEqual([
        { op: 4, d: { selfMute: true, selfDeaf: true, selfStream: false, guildId: 'g', channelId: 'vc' } },
      ])
    })

    it('undeafen restores the prior explicit mute', () => {
      client.setSelfVoice({ selfDeaf: true })
      expect(client.setSelfVoice({ selfDeaf: false })).toEqual({
        ownMute: false,
        selfMute: false,
        selfDeaf: false,
      })
      client.setSelfVoice({ selfMute: true })
      client.setSelfVoice({ selfDeaf: true })
      expect(client.setSelfVoice({ selfDeaf: false })).toEqual({
        ownMute: true,
        selfMute: true,
        selfDeaf: false,
      })
    })

    it('deafen leaves the own mute choice untouched', () => {
      client.setSelfVoice({ selfDeaf: true })
      expect(client.selfVoice).toEqual({
        ownMute: false,
        selfMute: true,
        selfDeaf: true,
      })
    })

    it('setScreen streams only in voice, and leaving voice ends the stream', async () => {
      const connect = vi.spyOn(VoiceConnection.prototype, 'connect').mockResolvedValue()
      const setScreen = vi.spyOn(VoiceConnection.prototype, 'setScreen').mockResolvedValue()
      const track = {} as MediaStreamTrack
      await client.setScreen(track)
      expect(voiceFrames()).toHaveLength(0)

      void client.joinVoice('g', 'vc')
      dispatch('VOICE_SERVER_UPDATE', {
        guildId: 'g',
        channelId: 'vc',
        endpoint: 'ws://media',
        token: 'vt',
        iceServers: [],
        expiresAt: '',
      })
      await vi.advanceTimersByTimeAsync(0)
      const before = voiceFrames().length
      await client.setScreen(track, { maxBitrate: 1, maxFramerate: 30 })
      await client.setScreen(track, { maxBitrate: 2, maxFramerate: 60 }) // quality change: no frame
      expect(voiceFrames().slice(before)).toEqual([
        { op: 4, d: { selfMute: false, selfDeaf: false, selfStream: true, guildId: 'g', channelId: 'vc' } },
      ])
      expect(setScreen).toHaveBeenLastCalledWith(track, { maxBitrate: 2, maxFramerate: 60 })
      client.leaveVoice()
      expect(voiceFrames().at(-1)).toEqual({
        op: 4,
        d: { selfMute: false, selfDeaf: false, selfStream: false, guildId: 'g', channelId: null },
      })
      connect.mockRestore()
      setScreen.mockRestore()
    })

    it('unmuting while deafened also undeafens', () => {
      client.setSelfVoice({ selfDeaf: true })
      expect(client.setSelfVoice({ selfMute: false })).toEqual({
        ownMute: false,
        selfMute: false,
        selfDeaf: false,
      })
    })
  })
})

describe('HachimanClient E2EE wiring', () => {
  const server = {
    guildId: 'g',
    channelId: 'vc',
    endpoint: 'ws://media',
    token: 'vt',
    iceServers: [],
    expiresAt: '',
  }
  let current: typeof device | null
  let delegates: FakeDelegate[]
  let client: HachimanClient

  beforeEach(() => {
    vi.useFakeTimers()
    installFakeWebSocket()
    current = null
    delegates = []
    client = new HachimanClient({
      apiUrl: 'http://api',
      gatewayUrl: 'ws://gw',
      getToken: () => Promise.resolve('t'),
      device: () => current,
      voiceE2ee: () => {
        const d = fakeDelegate()
        delegates.push(d)
        return d
      },
    })
  })
  afterEach(() => {
    client.disconnect()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function ready(): Promise<FakeWebSocket> {
    const ws = FakeWebSocket.last
    ws.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await vi.advanceTimersByTimeAsync(0)
    ws.recv({ op: 0, s: 1, t: 'READY', d: readyPayload })
    return ws
  }

  it('connect() waits while device() returns null, then IDENTIFYs with the device', async () => {
    client.connect()
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWebSocket.instances).toHaveLength(0)
    current = device
    await vi.advanceTimersByTimeAsync(250)
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.last
    ws.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.sent[0]).toEqual({
      op: 2,
      d: { token: 't', deviceId: 'dev1', capabilities: ['e2ee/1'], clientVersion: '1.0.0' },
    })
  })

  it('disconnect() stops the device wait', async () => {
    client.connect()
    client.disconnect()
    current = device
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('REST requests send X-Hachiman-Device from device()', async () => {
    current = device
    let headers: Record<string, string> = {}
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>
      return Promise.resolve(new Response('[]', { status: 200 }))
    })
    await client.rest.listDevices()
    expect(headers['X-Hachiman-Device']).toBe('dev1')
  })

  it('joinVoice makes one delegate per call, passes it to the connection, and the connection closes it', async () => {
    current = device
    vi.spyOn(VoiceConnection.prototype, 'connect').mockResolvedValue()
    client.connect()
    const ws = await ready()
    const first = client.joinVoice('g', 'vc')
    expect(delegates).toHaveLength(0) // made only after VOICE_SERVER_UPDATE
    ws.recv({ op: 0, s: 2, t: 'VOICE_SERVER_UPDATE', d: server })
    await first
    expect(delegates).toHaveLength(1)

    const second = client.joinVoice('g', 'vc')
    expect(delegates[0]?.closeCount).toBe(1)
    ws.recv({ op: 0, s: 3, t: 'VOICE_SERVER_UPDATE', d: server })
    await second
    expect(delegates).toHaveLength(2)
    expect(delegates[1]?.closeCount).toBe(0)
    client.leaveVoice()
    expect(delegates[1]?.closeCount).toBe(1)
  })

  it('a 4013 resync from media emits voiceResync with the target and leaves voice', async () => {
    current = device
    vi.spyOn(VoiceConnection.prototype, 'connect').mockResolvedValue()
    client.connect()
    const ws = await ready()
    const join = client.joinVoice('g', 'vc')
    ws.recv({ op: 0, s: 2, t: 'VOICE_SERVER_UPDATE', d: server })
    const vc = await join
    const resync = vi.fn(() => client.voice)
    client.on('voiceResync', resync)
    vc.emit('resync', { code: 4013, reason: '' })
    vc.emit('close', { code: 4013, reason: '' })
    expect(resync).toHaveBeenCalledWith({ guildId: 'g', channelId: 'vc' })
    expect(resync).toHaveReturnedWith(vc) // the event fires before the client leaves voice
    expect(client.voice).toBeNull()
    expect(ws.sent.at(-1)).toMatchObject({ op: 4, d: { guildId: 'g', channelId: null } })
  })

  it.each([4012, 4013])('gateway close %i emits fatal and does not reconnect', async code => {
    current = device
    client.connect()
    const ws = await ready()
    const fatal = vi.fn()
    client.on('fatal', fatal)
    ws.drop(code)
    expect(fatal).toHaveBeenCalledWith({ code })
    expect(client.gateway.state).toBe('closed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
