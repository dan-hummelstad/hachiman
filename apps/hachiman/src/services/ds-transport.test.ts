import { afterEach, describe, expect, it } from 'vitest'
import {
  Permissions,
  RestClient,
  type Channel,
  type Guild,
  type HachimanCache,
  type Member,
  type Role,
  type User
} from '@hachiman/client'
import { CryptoError, type DsTransport } from '@hachiman/crypto'
import { channelReaders, createDsTransport, transportError } from './ds-transport'

const realFetch = globalThis.fetch

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A RestClient on a fake fetch that answers each request with `answer`. */
function rest(answer: (req: Seen) => { status: number; body?: unknown }): {
  rest: RestClient
  seen: Seen[]
} {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    seen.push(req)
    const { status, body } = answer(req)
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
  return {
    rest: new RestClient({
      baseUrl: 'http://takusen/api/v1',
      getToken: async () => 'token',
      getDeviceId: () => 'dev-1'
    }),
    seen
  }
}

const emptyCache = (): HachimanCache => ({
  user: null,
  guilds: new Map(),
  channels: new Map(),
  roles: new Map(),
  members: new Map(),
  presences: new Map(),
  customStatuses: new Map(),
  voiceStates: new Map(),
  readStates: new Map()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('createDsTransport', () => {
  it('maps 404 UnknownGroup of the channel group to null', async () => {
    const { rest: r, seen } = rest(() => ({ status: 404, body: { error: 'UnknownGroup' } }))
    const t = createDsTransport(r, emptyCache())
    expect(await t.getGroupForChannel('c-1')).toBeNull()
    expect(seen[0]?.url).toBe('http://takusen/api/v1/channels/c-1/mls-group')
  })

  it('rejects another 404 as Transport with the REST code', async () => {
    const { rest: r } = rest(() => ({ status: 404, body: { error: 'UnknownChannel' } }))
    const t = createDsTransport(r, emptyCache())
    let caught: unknown
    await t.getGroupForChannel('c-1').catch((e: unknown) => (caught = e))
    expect(caught).toBeInstanceOf(CryptoError)
    expect((caught as CryptoError).code).toBe('Transport')
    expect((caught as CryptoError).dsCode).toBe('UnknownChannel')
  })

  it('resolves 409 EpochConflict of postCommit as a value', async () => {
    const { rest: r } = rest(() => ({ status: 409, body: { error: 'EpochConflict', epoch: 7 } }))
    const t = createDsTransport(r, emptyCache())
    const result = await t.postCommit('grp', {
      epoch: 6,
      commit: 'AA',
      groupInfo: 'AA',
      ratchetTree: 'AA',
      welcome: null,
      batchId: null,
      rejected: []
    })
    expect(result).toEqual({ ok: false, code: 'EpochConflict', epoch: 7 })
  })

  it('sends X-Hachiman-Device and the right route for each call', async () => {
    const { rest: r, seen } = rest(() => ({ status: 200, body: [] }))
    const t = createDsTransport(r, emptyCache())
    await t.fetchHandshakes('grp', 5, 10)
    await t.fetchInbox(3)
    await t.listOwnDevices()
    await t.adminActions('g-1', 2)
    await t.ktEntries({ userId: 'u-1', after: 4 })
    await t.fetchLinkMessages('s-1', 9)
    expect(seen.map((s) => `${s.method} ${s.url.replace('http://takusen/api/v1', '')}`)).toEqual([
      'GET /mls/groups/grp/handshakes?after=5&limit=10',
      'GET /devices/@me/inbox?after=3',
      'GET /devices',
      'GET /guilds/g-1/admin-actions?after=2',
      'GET /kt/entries?userId=u-1&after=4',
      'GET /devices/link-sessions/s-1/messages?after=9'
    ])
    for (const s of seen) expect(s.headers['X-Hachiman-Device']).toBe('dev-1')
  })

  it('passes bodies through unchanged', async () => {
    const { rest: r, seen } = rest(() => ({ status: 204 }))
    const t = createDsTransport(r, emptyCache())
    await t.revokeDevice('d-2', { revocation: 'REV', reason: 'lost' })
    await t.postInbox('d-3', { kind: 'history_keys', body: 'BODY' })
    await t.declineBatch('b-1', 'busy')
    expect(seen.map((s) => [s.method, s.url.replace('http://takusen/api/v1', ''), s.body])).toEqual(
      [
        ['POST', '/devices/d-2/revoke', { revocation: 'REV', reason: 'lost' }],
        ['POST', '/devices/d-3/inbox', { kind: 'history_keys', body: 'BODY' }],
        ['POST', '/mls/batches/b-1/decline', { reason: 'busy' }]
      ]
    )
  })

  it('implements every DsTransport method', () => {
    const t = createDsTransport(rest(() => ({ status: 200 })).rest, emptyCache())
    const methods: (keyof DsTransport)[] = [
      'registerDevice',
      'putDeviceCertificate',
      'listOwnDevices',
      'revokeDevice',
      'renameDevice',
      'getUserKeys',
      'putMasterKey',
      'putDeviceSigningKey',
      'getDsInfo',
      'uploadKeyPackages',
      'countKeyPackages',
      'listGroups',
      'getGroup',
      'getGroupForChannel',
      'getGroupState',
      'createGroup',
      'postCommit',
      'fetchHandshakes',
      'postJoinRequest',
      'getJoinRequest',
      'declineBatch',
      'fetchInbox',
      'ackInbox',
      'postInbox',
      'getBackups',
      'putIdentityBackup',
      'postHistoryBackup',
      'getBackup',
      'deleteBackups',
      'postHistoryBundle',
      'getHistoryBundles',
      'createLinkSession',
      'listLinkSessions',
      'postLinkMessage',
      'fetchLinkMessages',
      'deleteLinkSession',
      'ktTreeHead',
      'ktInclusion',
      'ktConsistency',
      'ktEntries',
      'adminActions',
      'inviteRecords',
      'postInviteBundle',
      'inviteBundles',
      'channelReaders',
      'guildMembers'
    ]
    for (const m of methods) expect(typeof t[m]).toBe('function')
    expect(Object.keys(t).sort()).toEqual([...methods].sort())
  })

  it('calls the invite routes of §12.12 and rejects 404 UnknownInvite as Transport', async () => {
    const records = [
      { inviteId: 'i-1', keyId: 'S0lE', record: 'UkVD', expiresAt: null, bundled: [{ groupId: 'R1', epoch: 3 }] }
    ]
    const bundles = { inviteId: 'i-1', record: 'UkVD', bundles: [] }
    const { rest: r, seen } = rest((req) =>
      req.url.endsWith('/invite-records')
        ? { status: 200, body: records }
        : req.method === 'POST'
          ? { status: 204 }
          : { status: 200, body: bundles }
    )
    const t = createDsTransport(r, emptyCache())
    expect(await t.inviteRecords('g-1')).toEqual(records)
    expect(await t.postInviteBundle('i-1', { groupId: 'R1', epoch: 4, blob: 'QkxC' })).toBeUndefined()
    expect(await t.inviteBundles('ABCD2345')).toEqual(bundles)
    expect(seen.map((s) => `${s.method} ${s.url.replace('http://takusen/api/v1', '')}`)).toEqual([
      'GET /guilds/g-1/invite-records',
      'POST /invite-records/i-1/bundles',
      'GET /invites/ABCD2345/bundles'
    ])
    expect(seen[1]?.body).toEqual({ groupId: 'R1', epoch: 4, blob: 'QkxC' })
    for (const s of seen) expect(s.headers['X-Hachiman-Device']).toBe('dev-1')

    const { rest: gone } = rest(() => ({ status: 404, body: { error: 'UnknownInvite' } }))
    let caught: unknown
    await createDsTransport(gone, emptyCache())
      .inviteBundles('ABCD2345')
      .catch((e: unknown) => (caught = e))
    expect(caught).toBeInstanceOf(CryptoError)
    expect((caught as CryptoError).code).toBe('Transport')
    expect((caught as CryptoError).dsCode).toBe('UnknownInvite')
  })
})

describe('transportError', () => {
  it('gives a network error no dsCode', () => {
    const e = transportError(new TypeError('offline'))
    expect(e.code).toBe('Transport')
    expect(e.dsCode).toBeUndefined()
  })
})

describe('channelReaders', () => {
  const VIEW = Permissions.VIEW_CHANNEL
  const guild: Guild = {
    id: 'g-1',
    name: 'G',
    icon: null,
    banner: null,
    ownerId: 'u-owner',
    region: null,
    createdAt: '',
    publicHistoryVisibility: 'shared'
  }
  const user = (id: string): User => ({ id, username: id, avatar: null })
  const member = (id: string, roles: string[] = []): Member => ({
    guildId: 'g-1',
    user: user(id),
    nick: null,
    roles,
    joinedAt: ''
  })
  const role = (id: string, permissions: number): Role => ({
    id,
    guildId: 'g-1',
    name: id,
    color: 0,
    position: id === 'g-1' ? 0 : 1,
    permissions
  })
  const text = (overwrites: Channel['permissionOverwrites']): Channel => ({
    id: 'c-1',
    guildId: 'g-1',
    type: 'text',
    name: 'general',
    topic: null,
    parentId: null,
    position: 0,
    permissionOverwrites: overwrites,
    mlsGroupId: null,
    historyVisibility: 'shared'
  })

  function cacheWith(channel: Channel): HachimanCache {
    const c = emptyCache()
    c.guilds.set('g-1', guild)
    c.channels.set(channel.id, channel)
    c.roles.set(
      'g-1',
      new Map([
        ['g-1', role('g-1', VIEW)],
        ['r-staff', role('r-staff', VIEW)]
      ])
    )
    c.members.set(
      'g-1',
      new Map([
        ['u-owner', member('u-owner')],
        ['u-staff', member('u-staff', ['r-staff'])],
        ['u-plain', member('u-plain')]
      ])
    )
    return c
  }

  it('applies the overwrites (§2): a private channel has the owner and the allowed role', () => {
    const c = cacheWith(
      text([
        { id: 'g-1', type: 'role', allow: 0, deny: VIEW },
        { id: 'r-staff', type: 'role', allow: VIEW, deny: 0 }
      ])
    )
    expect(channelReaders(c, 'c-1').sort()).toEqual(['u-owner', 'u-staff'])
  })

  it('gives every member of a public channel', () => {
    expect(channelReaders(cacheWith(text([])), 'c-1').sort()).toEqual([
      'u-owner',
      'u-plain',
      'u-staff'
    ])
  })

  it('gives the DM participants and me', () => {
    const c = emptyCache()
    c.user = user('u-me')
    c.channels.set('dm-1', {
      ...text([]),
      id: 'dm-1',
      guildId: null,
      type: 'dm',
      recipients: [user('u-friend')]
    })
    expect(channelReaders(c, 'dm-1').sort()).toEqual(['u-friend', 'u-me'])
  })

  it('gives no readers for an unknown channel (fail closed)', () => {
    expect(channelReaders(emptyCache(), 'nope')).toEqual([])
  })
})
