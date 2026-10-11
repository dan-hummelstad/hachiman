import { Permissions, type Channel, type Invite } from '@hachiman/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INVITE_SOON_MS,
  countActiveInvites,
  inviteExpiryChoices,
  inviteExpiryState,
  inviteScope,
  inviteUsesLabel,
  isInviteExpiryChoice,
  isUsedUp,
  maxUsesLabel,
  sortInvites
} from './invites'

// MARK: - the client and the services that InviteService uses

const rest = {
  getInvites: vi.fn<(guildId: string) => Promise<Invite[]>>(),
  deleteInvite: vi.fn<(code: string) => Promise<void>>(() => Promise.resolve())
}
const gatewayHandlers = new Map<string, (d: unknown) => void>()
vi.mock('@/services/client', () => ({
  hachiman: {
    rest,
    cache: { members: new Map() },
    on: (event: string, fn: (d: unknown) => void) => gatewayHandlers.set(event, fn)
  }
}))
vi.mock('@/services/CryptoService', () => ({ cryptoService: { ready: false } }))
vi.mock('@/stores/navStore', () => ({ selectGuild: vi.fn() }))

const {
  addGuildInvite,
  copyLinkFromTap,
  guildInviteList,
  loadGuildInvites,
  resetInvites,
  revokeGuildInvite,
  subscribeGuildInviteLists
} = await import('@/services/InviteService')

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetInvites()
})

describe('inviteExpiryChoices', () => {
  it('gives a member without ADMINISTRATOR at most 24 hours and no permanent invite', () => {
    const seconds = inviteExpiryChoices(false).map((c) => c.seconds)
    expect(Math.max(...seconds)).toBe(86400)
    expect(seconds).not.toContain(0)
  })

  it('gives an administrator 7 days and a permanent invite too', () => {
    const choices = inviteExpiryChoices(true)
    expect(choices.map((c) => c.seconds)).toEqual([
      ...inviteExpiryChoices(false).map((c) => c.seconds),
      604800,
      0
    ])
    expect(choices.find((c) => c.seconds === 0)?.label).toBe('Permanent')
  })
})

describe('isInviteExpiryChoice', () => {
  it('rejects 7 days and permanent once the user is not an administrator', () => {
    for (const seconds of [604800, 0]) {
      expect(isInviteExpiryChoice(seconds, true)).toBe(true)
      expect(isInviteExpiryChoice(seconds, false)).toBe(false)
    }
    expect(isInviteExpiryChoice(86400, false)).toBe(true)
    expect(isInviteExpiryChoice(12345, true)).toBe(false)
  })
})

describe('sortInvites', () => {
  it('puts permanent invites first and keeps the order otherwise', () => {
    const list = [
      { code: 'a', expiresAt: '2026-10-07T00:00:00Z' },
      { code: 'b', expiresAt: null },
      { code: 'c', expiresAt: '2026-10-06T00:00:00Z' },
      { code: 'd', expiresAt: null }
    ]
    expect(sortInvites(list).map((i) => i.code)).toEqual(['b', 'd', 'a', 'c'])
    expect(list.map((i) => i.code)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('maxUsesLabel', () => {
  it('names no limit, one use and more uses', () => {
    expect([0, 1, 25].map(maxUsesLabel)).toEqual(['No limit', '1 use', '25 uses'])
  })
})

describe('isUsedUp', () => {
  it('is true once the uses reach the limit', () => {
    expect(isUsedUp({ uses: 8, maxUses: 8 })).toBe(true)
    expect(isUsedUp({ uses: 9, maxUses: 8 })).toBe(true)
    expect(isUsedUp({ uses: 7, maxUses: 8 })).toBe(false)
  })

  it('is never true without a limit (null or 0)', () => {
    expect(isUsedUp({ uses: 500, maxUses: null })).toBe(false)
    expect(isUsedUp({ uses: 500, maxUses: 0 })).toBe(false)
  })
})

describe('inviteExpiryState', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const at = (ms: number): string => new Date(now + ms).toISOString()
  const state = (expiresAt: string | null, uses = 0, maxUses: number | null = null): string =>
    inviteExpiryState({ expiresAt, uses, maxUses }, now)

  it('names a permanent invite, a close expiry and a far one', () => {
    expect(state(null)).toBe('permanent')
    expect(state(at(2 * 86_400_000))).toBe('soon')
    expect(state(at(INVITE_SOON_MS - 1))).toBe('soon')
    expect(state(at(INVITE_SOON_MS))).toBe('later')
    expect(state(at(7 * 86_400_000))).toBe('later')
  })

  it('counts an expiry at now or before it, and an unreadable date, as expired', () => {
    expect(state(at(0))).toBe('expired')
    expect(state(at(-60_000))).toBe('expired')
    expect(state('not a date')).toBe('expired')
  })

  it('puts used up before every expiry state', () => {
    expect(state(null, 8, 8)).toBe('usedUp')
    expect(state(at(-60_000), 1, 1)).toBe('usedUp')
    expect(state(at(86_400_000), 1, 1)).toBe('usedUp')
  })
})

describe('countActiveInvites', () => {
  it('counts the invites that are not used up and not expired', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    const day = (n: number): string => new Date(now + n * 86_400_000).toISOString()
    const invites = [
      { expiresAt: day(7), uses: 3, maxUses: null },
      { expiresAt: day(2), uses: 11, maxUses: 25 },
      { expiresAt: day(1), uses: 8, maxUses: 8 },
      { expiresAt: day(-1), uses: 0, maxUses: null },
      { expiresAt: null, uses: 0, maxUses: null }
    ]
    expect(countActiveInvites(invites, now)).toBe(3)
    expect(countActiveInvites([], now)).toBe(0)
  })
})

describe('inviteUsesLabel', () => {
  it('shows the uses, and the limit when there is one', () => {
    expect(inviteUsesLabel({ uses: 3, maxUses: null })).toBe('3 uses')
    expect(inviteUsesLabel({ uses: 1, maxUses: 0 })).toBe('1 use')
    expect(inviteUsesLabel({ uses: 11, maxUses: 25 })).toBe('11 / 25 uses')
    expect(inviteUsesLabel({ uses: 0, maxUses: 1 })).toBe('0 / 1 use')
  })
})

describe('inviteScope', () => {
  const guild = { id: 'g', ownerId: 'owner' }
  const VIEW = Permissions.VIEW_CHANNEL
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
    ...over
  })
  const roles = new Map([
    ['g', { id: 'g', permissions: VIEW }],
    ['mods', { id: 'mods', permissions: VIEW | Permissions.MANAGE_GUILD }]
  ])

  it('lists the text and pages channels that @everyone can view, in sidebar order', () => {
    const scope = inviteScope(guild, roles, [
      channel('rules', { position: 2 }),
      channel('docs', { type: 'pages', position: 1 }),
      channel('lounge', { type: 'voice' }),
      channel('cat', { type: 'category' }),
      channel('other-guild', { guildId: 'h' }),
      channel('mods-only', {
        permissionOverwrites: [
          { id: 'g', type: 'role', allow: 0, deny: VIEW },
          { id: 'mods', type: 'role', allow: VIEW, deny: 0 }
        ]
      }),
      channel('owner-only', {
        permissionOverwrites: [
          { id: 'g', type: 'role', allow: 0, deny: VIEW },
          { id: 'owner', type: 'member', allow: VIEW, deny: 0 }
        ]
      })
    ])
    expect(scope.map((c) => c.id)).toEqual(['docs', 'rules'])
  })

  it('follows an @everyone overwrite that opens a channel', () => {
    const closed = new Map([['g', { id: 'g', permissions: 0 }]])
    const open = channel('open', {
      permissionOverwrites: [{ id: 'g', type: 'role', allow: VIEW, deny: 0 }]
    })
    expect(inviteScope(guild, closed, [channel('a'), open]).map((c) => c.id)).toEqual(['open'])
  })
})

// MARK: - InviteService: the invite list of a guild and the copy of a new link

const invite = (code: string, over: Partial<Invite> = {}): Invite => ({
  id: `id-${code}`,
  code,
  guildId: 'g',
  createdBy: 'me',
  expiresAt: null,
  maxUses: null,
  uses: 0,
  createdAt: '2026-10-11T00:00:00Z',
  hasHistory: false,
  ...over
})

describe('the invite list of a guild', () => {
  it('loads once while a load is in flight or fresh, and again after 10 s', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    rest.getInvites.mockResolvedValue([invite('a')])
    const first = loadGuildInvites('g')
    expect(loadGuildInvites('g')).toBe(first)
    await first
    expect(guildInviteList('g')).toEqual({ invites: [invite('a')], at: 1_000_000 })
    await loadGuildInvites('g')
    expect(rest.getInvites).toHaveBeenCalledTimes(1)
    vi.setSystemTime(1_010_000)
    await loadGuildInvites('g')
    expect(rest.getInvites).toHaveBeenCalledTimes(2)
  })

  it('loads again after a failed load, and rejects with its error', async () => {
    rest.getInvites.mockRejectedValueOnce(new Error('offline'))
    await expect(loadGuildInvites('g')).rejects.toThrow('offline')
    expect(guildInviteList('g')).toBeUndefined()
    rest.getInvites.mockResolvedValueOnce([invite('a')])
    await loadGuildInvites('g')
    expect(guildInviteList('g')?.invites).toEqual([invite('a')])
  })

  it('puts a new invite first, follows INVITE_DELETE and a revoke, and tells listeners', async () => {
    rest.getInvites.mockResolvedValue([invite('a'), invite('b')])
    await loadGuildInvites('g')
    const listener = vi.fn()
    const unsubscribe = subscribeGuildInviteLists(listener)

    addGuildInvite(invite('c'))
    expect(guildInviteList('g')?.invites.map((i) => i.code)).toEqual(['c', 'a', 'b'])

    gatewayHandlers.get('INVITE_DELETE')?.({ guildId: 'g', code: 'a', inviteId: 'id-a' })
    expect(guildInviteList('g')?.invites.map((i) => i.code)).toEqual(['c', 'b'])
    // A code of another guild, or one that is gone, changes nothing.
    gatewayHandlers.get('INVITE_DELETE')?.({ guildId: 'h', code: 'b', inviteId: 'id-b' })
    gatewayHandlers.get('INVITE_DELETE')?.({ guildId: 'g', code: 'a', inviteId: 'id-a' })

    await revokeGuildInvite('g', 'b')
    expect(rest.deleteInvite).toHaveBeenCalledWith('b')
    expect(guildInviteList('g')?.invites.map((i) => i.code)).toEqual(['c'])
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    addGuildInvite(invite('d'))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('keeps the invite in the list when the revoke fails', async () => {
    rest.getInvites.mockResolvedValue([invite('a')])
    await loadGuildInvites('g')
    rest.deleteInvite.mockRejectedValueOnce(new Error('403'))
    await expect(revokeGuildInvite('g', 'a')).rejects.toThrow('403')
    expect(guildInviteList('g')?.invites).toEqual([invite('a')])
  })

  it('forgets every list at sign-out, also the result of a load in flight', async () => {
    let resolve: (v: Invite[]) => void = () => undefined
    rest.getInvites.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const pending = loadGuildInvites('g')
    addGuildInvite(invite('h', { guildId: 'h' }))
    resetInvites()
    resolve([invite('a')])
    await pending
    expect(guildInviteList('g')).toBeUndefined()
    expect(guildInviteList('h')).toBeUndefined()
  })
})

describe('copyLinkFromTap', () => {
  /** A ClipboardItem stand-in that keeps what it was given. */
  class FakeItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  const deferred = (): {
    promise: Promise<string>
    resolve: (v: string) => void
    reject: (e: Error) => void
  } => {
    let resolve: (v: string) => void = () => undefined
    let reject: (e: Error) => void = () => undefined
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('starts the write before the link is ready, with the link as its text', async () => {
    const write = vi.fn((items: FakeItem[]) => items[0].items['text/plain'].then(() => undefined))
    vi.stubGlobal('ClipboardItem', FakeItem)
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } })
    const link = deferred()
    const copied = copyLinkFromTap(link.promise)
    expect(write).toHaveBeenCalledTimes(1)
    link.resolve('https://id.example/invite/c0de#k=seed')
    expect(await copied).toBe(true)
    const blob = await write.mock.calls[0][0][0].items['text/plain']
    expect(await blob.text()).toBe('https://id.example/invite/c0de#k=seed')
  })

  it('resolves false when the write fails or the link fails, and never rejects', async () => {
    vi.stubGlobal('ClipboardItem', FakeItem)
    const write = vi.fn((items: FakeItem[]) => items[0].items['text/plain'].then(() => undefined))
    vi.stubGlobal('navigator', { clipboard: { write } })
    const failed = deferred()
    const copied = copyLinkFromTap(failed.promise)
    failed.reject(new Error('could not create'))
    expect(await copied).toBe(false)

    write.mockRejectedValueOnce(new Error('NotAllowedError'))
    expect(await copyLinkFromTap(Promise.resolve('https://id.example/invite/c0de'))).toBe(false)
  })

  it('writes the text once the link is ready where there is no ClipboardItem', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const link = deferred()
    const copied = copyLinkFromTap(link.promise)
    expect(writeText).not.toHaveBeenCalled()
    link.resolve('https://id.example/invite/c0de')
    expect(await copied).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://id.example/invite/c0de')
  })

  it('writes the text once ready when ClipboardItem takes no promise', async () => {
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor() {
          throw new TypeError('no promise values')
        }
      }
    )
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn(), writeText } })
    expect(await copyLinkFromTap(Promise.resolve('https://id.example/invite/c0de'))).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://id.example/invite/c0de')
  })

  it('resolves false with no clipboard at all', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    vi.stubGlobal('navigator', {})
    expect(await copyLinkFromTap(Promise.resolve('https://id.example/invite/c0de'))).toBe(false)
    const failed = deferred()
    const copied = copyLinkFromTap(failed.promise)
    failed.reject(new Error('could not create'))
    expect(await copied).toBe(false)
  })
})
