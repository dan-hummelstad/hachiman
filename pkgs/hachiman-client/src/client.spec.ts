import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HachimanClient } from './client'
import { VoiceConnection } from './voice'
import { Permissions as P } from './permissions'
import { FakeWebSocket, installFakeWebSocket } from './test/fake-ws'
import type { Channel, GuildFull, Member, ReadyPayload, User } from './types'

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
      position: 0,
      permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES,
    },
  ],
  members: [member(me), member(bob)],
  voiceStates: [
    { guildId: 'g', channelId: 'vc', userId: 'bob', sessionId: 'x', selfMute: false, selfDeaf: false, selfStream: false },
  ],
  presences: [{ userId: 'bob', status: 'online' }],
}
const readyPayload: ReadyPayload = {
  v: 1,
  sessionId: 'S',
  user: me,
  guilds: [guild],
  privateChannels: [channel('dm', { guildId: null, type: 'dm', name: null })],
  presences: [],
}

describe('HachimanClient cache', () => {
  let client: HachimanClient
  let ws: FakeWebSocket
  let seq = 0
  const dispatch = (t: string, d: unknown) => {
    ws.recv({ op: 0, s: ++seq, t, d })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    installFakeWebSocket()
    client = new HachimanClient({
      apiUrl: 'http://api',
      gatewayUrl: 'ws://gw',
      getToken: () => Promise.resolve('t'),
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
    dispatch('GUILD_UPDATE', { id, name, icon, banner: 'u3/banner.webp', ownerId, region, createdAt })
    expect(client.cache.guilds.get('g')?.banner).toBe('u3/banner.webp')
  })

  it('MESSAGE_CREATE is re-emitted (messages are not cached)', () => {
    const msg = vi.fn()
    client.on('MESSAGE_CREATE', msg)
    const m = {
      id: 'm1',
      channelId: 'general',
      guildId: 'g',
      author: bob,
      content: 'hi',
      attachments: [],
      createdAt: '',
      editedAt: null,
      nonce: 'n',
    }
    dispatch('MESSAGE_CREATE', m)
    expect(msg).toHaveBeenCalledWith(m)
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
