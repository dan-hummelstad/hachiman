import { CryptoError, INVITE_BUNDLE_FETCH_WINDOW_MS } from '@hachiman/crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCryptoStore } from '@/stores/cryptoStore'

const rest = {
  createInvite: vi.fn((_guildId: string, body: object) =>
    Promise.resolve({ id: 'inv-1', code: 'c0de', ...body })
  ),
  acceptInvite: vi.fn<(code: string) => Promise<{ id: string }>>(() =>
    Promise.resolve({ id: 'g' })
  ),
  deleteInvite: vi.fn<(code: string) => Promise<void>>(() => Promise.resolve())
}
const cache = {
  user: { id: 'me' },
  members: new Map<string, Map<string, unknown>>()
}
vi.mock('@/services/client', () => ({ hachiman: { rest, cache } }))

const crypto = {
  prepareHistoryInvite: vi.fn((input: { channelIds: string[] }) =>
    Promise.resolve({ record: 'rec', linkSecret: 'seed', channelIds: input.channelIds.slice(1) })
  ),
  sendInviteBundles: vi.fn<(input: object) => Promise<{ groups: number }>>(() =>
    Promise.resolve({ groups: 1 })
  ),
  redeemInvite: vi.fn<(input: object) => Promise<{ groups: number; keys: number }>>(() =>
    Promise.resolve({ groups: 1, keys: 3 })
  )
}
const cryptoService = { ready: false, client: () => crypto }
vi.mock('@/services/CryptoService', () => ({ cryptoService }))
vi.mock('@/stores/navStore', () => ({ selectGuild: vi.fn() }))

const {
  acceptInvite,
  createHistoryInvite,
  createInvite,
  DEFAULT_INVITE_OPTIONS,
  dropSignInInviteKeys,
  inviteUrl,
  keepInviteKeyForSignIn,
  peekInviteKey,
  redeemWaitingInvites,
  resetInvites,
  restoreInviteKey,
  stashInviteKey
} = await import('./InviteService')

/** Lets the promise callbacks of redeemWaitingInvites run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function stubSessionStorage(): Map<string, string> {
  const storage = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    get length() {
      return storage.size
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    getItem: (k: string) => storage.get(k) ?? null,
    removeItem: (k: string) => storage.delete(k)
  })
  return storage
}

const failures = (): string[] => useCryptoStore.getState().inviteHistoryFailures
/** REDEEM_RETRY_MAX_MS of InviteService. */
const REDEEM_WAIT_MAX = 5 * 60_000

afterEach(() => {
  // Also gives each vi.fn its first implementation back.
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetInvites()
  cryptoService.ready = false
  cache.members.clear()
  useCryptoStore.setState({ inviteHistoryFailures: [] })
})

describe('createInvite', () => {
  it('the default invite is 24 hours with no use limit, which every member may create', async () => {
    await createInvite('g', DEFAULT_INVITE_OPTIONS)
    expect(rest.createInvite).toHaveBeenCalledWith('g', {
      maxAgeSeconds: 86400,
      maxUses: undefined,
      acknowledgedPermanent: undefined
    })
  })

  it('a permanent invite sends maxAgeSeconds 0 and the acknowledgment', async () => {
    await createInvite('g', { expiry: 0, maxUses: 5 }, true)
    expect(rest.createInvite).toHaveBeenCalledWith('g', {
      maxAgeSeconds: 0,
      maxUses: 5,
      acknowledgedPermanent: true
    })
    await createInvite('g', { expiry: 0, maxUses: 0 })
    expect(rest.createInvite).toHaveBeenLastCalledWith('g', {
      maxAgeSeconds: 0,
      maxUses: undefined,
      acknowledgedPermanent: false
    })
  })

  it('an invite with an expiry never sends the acknowledgment', async () => {
    await createInvite('g', { expiry: 3600, maxUses: 0 }, true)
    expect(rest.createInvite).toHaveBeenCalledWith('g', {
      maxAgeSeconds: 3600,
      maxUses: undefined,
      acknowledgedPermanent: undefined
    })
  })
})

describe('createHistoryInvite', () => {
  it('signs the record, creates the invite with it, then sends the bundles', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const made = await createHistoryInvite('g', { expiry: 3600, maxUses: 1 }, ['c1', 'c2', 'c3'])
    expect(crypto.prepareHistoryInvite).toHaveBeenCalledWith({
      guildId: 'g',
      channelIds: ['c1', 'c2', 'c3'],
      expiresAtMs: 1_000_000 + 3_600_000,
      maxUses: 1
    })
    expect(rest.createInvite).toHaveBeenCalledWith('g', {
      maxAgeSeconds: 3600,
      maxUses: 1,
      acknowledgedPermanent: undefined,
      record: 'rec'
    })
    expect(crypto.sendInviteBundles).toHaveBeenCalledWith({
      guildId: 'g',
      inviteId: 'inv-1',
      record: 'rec'
    })
    // The scope is the one that the Worker signed, not the input.
    expect(made).toMatchObject({ key: 'seed', channelIds: ['c2', 'c3'], groups: 1 })
    expect(made.invite.code).toBe('c0de')
  })

  it('a permanent invite with history has expiresAtMs 0 and the acknowledgment', async () => {
    await createHistoryInvite('g', { expiry: 0, maxUses: 0 }, ['c1', 'c2'], true)
    expect(crypto.prepareHistoryInvite).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAtMs: 0, maxUses: 0 })
    )
    expect(rest.createInvite).toHaveBeenCalledWith(
      'g',
      expect.objectContaining({ maxAgeSeconds: 0, acknowledgedPermanent: true, record: 'rec' })
    )
  })

  it('revokes the invite when a bundle fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const e of [
      new CryptoError('InvalidChain', 'no'),
      // One failed post (the Worker rejects with it), for example 429.
      new CryptoError('Transport', 'slow down', 'RateLimited')
    ]) {
      crypto.sendInviteBundles.mockRejectedValueOnce(e)
      await expect(createHistoryInvite('g', DEFAULT_INVITE_OPTIONS, ['c1', 'c2'])).rejects.toThrow(
        'This device could not send the history of these channels. Try again.'
      )
    }
    expect(rest.deleteInvite).toHaveBeenCalledTimes(2)
    expect(rest.deleteInvite).toHaveBeenCalledWith('c0de')
    warn.mockRestore()
  })

  it('keeps the invite when this device holds no group of the scope', async () => {
    crypto.sendInviteBundles.mockResolvedValueOnce({ groups: 0 })
    const made = await createHistoryInvite('g', DEFAULT_INVITE_OPTIONS, ['c1', 'c2'])
    expect(made).toMatchObject({ key: 'seed', groups: 0 })
    expect(rest.deleteInvite).not.toHaveBeenCalled()
  })

  it('makes nothing when the Worker refuses the record', async () => {
    crypto.prepareHistoryInvite.mockRejectedValueOnce(new CryptoError('Unsupported', 'not admin'))
    await expect(createHistoryInvite('g', DEFAULT_INVITE_OPTIONS, ['c1'])).rejects.toThrow()
    expect(rest.createInvite).not.toHaveBeenCalled()
  })
})

it('the link of an invite with history carries the key in the fragment', () => {
  expect(inviteUrl('c0de')).toMatch(/\/invite\/c0de$/)
  expect(inviteUrl('c0de', 'seed')).toMatch(/\/invite\/c0de#k=seed$/)
})

describe('invite keys', () => {
  it('keeps a key in memory until the join', async () => {
    stashInviteKey('c0de', 'seed')
    expect(peekInviteKey('c0de')).toBe('seed')
    await acceptInvite('c0de')
    expect(peekInviteKey('c0de')).toBeNull()
    stashInviteKey('x', 'seed')
    stashInviteKey('x', null)
    expect(peekInviteKey('x')).toBeNull()
  })

  it('crosses the browser sign-in redirect in sessionStorage only', () => {
    const storage = stubSessionStorage()
    keepInviteKeyForSignIn('c0de', 'seed')
    expect(peekInviteKey('c0de')).toBeNull()
    restoreInviteKey('c0de')
    expect(peekInviteKey('c0de')).toBe('seed')
    expect(storage.size).toBe(0)
    // Nothing kept: the memory stays as it is.
    restoreInviteKey('c0de')
    expect(peekInviteKey('c0de')).toBe('seed')
  })

  it('drops at start-up the keys of a sign-in that did not finish', () => {
    const storage = stubSessionStorage()
    storage.set('other', 'x')
    keepInviteKeyForSignIn('c0de', 'seed')
    keepInviteKeyForSignIn('left', 'seed2')
    // The callback of the load URL restores its key first.
    restoreInviteKey('c0de')
    dropSignInInviteKeys()
    expect([...storage.keys()]).toEqual(['other'])
    expect(peekInviteKey('c0de')).toBe('seed')
    expect(peekInviteKey('left')).toBeNull()
  })

  it('works without sessionStorage', () => {
    vi.stubGlobal('sessionStorage', undefined)
    keepInviteKeyForSignIn('c0de', 'seed')
    restoreInviteKey('c0de')
    dropSignInInviteKeys()
    expect(peekInviteKey('c0de')).toBeNull()
  })
})

describe('redemption after the join', () => {
  const member = (): void => {
    cache.members.set('g', new Map([['me', {}]]))
  }

  it('a join without a key redeems nothing', async () => {
    cryptoService.ready = true
    member()
    await acceptInvite('c0de')
    await settle()
    expect(crypto.redeemInvite).not.toHaveBeenCalled()
  })

  it('redeems at once when encryption is ready and the guild is in the cache', async () => {
    cryptoService.ready = true
    member()
    await acceptInvite('c0de', 'seed')
    expect(crypto.redeemInvite).toHaveBeenCalledWith({ code: 'c0de', linkSecret: 'seed' })
    redeemWaitingInvites()
    expect(crypto.redeemInvite).toHaveBeenCalledOnce()
  })

  it('waits for encryption and for the guild members', async () => {
    await acceptInvite('c0de', 'seed')
    redeemWaitingInvites()
    cryptoService.ready = true
    redeemWaitingInvites()
    expect(crypto.redeemInvite).not.toHaveBeenCalled()
    member()
    redeemWaitingInvites()
    expect(crypto.redeemInvite).toHaveBeenCalledOnce()
  })

  it('tries again after GroupPending; another error is final and shows a notice', async () => {
    cryptoService.ready = true
    member()
    crypto.redeemInvite.mockRejectedValueOnce(new CryptoError('GroupPending', 'later'))
    await acceptInvite('c0de', 'seed')
    await settle()
    redeemWaitingInvites()
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(2)
    expect(failures()).toEqual([])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    crypto.redeemInvite.mockRejectedValueOnce(new CryptoError('InvalidChain', 'bad record'))
    await acceptInvite('other', 'seed')
    await settle()
    redeemWaitingInvites()
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalled()
    // The notice has the guild only: no key, no code.
    expect(failures()).toEqual(['g'])
    warn.mockRestore()
  })

  it('tries again after a transport error, with a growing wait', async () => {
    vi.useFakeTimers({ now: 0 })
    cryptoService.ready = true
    member()
    crypto.redeemInvite
      .mockRejectedValueOnce(new CryptoError('Transport', 'offline'))
      .mockRejectedValueOnce(new CryptoError('Transport', 'server error', 'HTTP_502'))
    await acceptInvite('c0de', 'seed')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(3)
    expect(crypto.redeemInvite).toHaveBeenLastCalledWith({ code: 'c0de', linkSecret: 'seed' })
    await vi.advanceTimersByTimeAsync(INVITE_BUNDLE_FETCH_WINDOW_MS)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(3)
    expect(failures()).toEqual([])
  })

  it('stops at the end of the fetch window, and at once on 404 UnknownInvite', async () => {
    vi.useFakeTimers({ now: 0 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    cryptoService.ready = true
    member()
    crypto.redeemInvite.mockRejectedValue(new CryptoError('Transport', 'offline'))
    await acceptInvite('c0de', 'seed')
    await vi.advanceTimersByTimeAsync(INVITE_BUNDLE_FETCH_WINDOW_MS)
    const tries = crypto.redeemInvite.mock.calls.length
    // 5 s doubling to 5 min: about 15 tries in the hour, not one per second.
    expect(tries).toBeGreaterThan(5)
    expect(tries).toBeLessThan(20)
    expect(failures()).toEqual(['g'])
    await vi.advanceTimersByTimeAsync(INVITE_BUNDLE_FETCH_WINDOW_MS)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(tries)

    crypto.redeemInvite.mockRejectedValue(new CryptoError('Transport', 'gone', 'UnknownInvite'))
    useCryptoStore.setState({ inviteHistoryFailures: [] })
    await acceptInvite('other', 'seed')
    await vi.advanceTimersByTimeAsync(REDEEM_WAIT_MAX)
    expect(crypto.redeemInvite).toHaveBeenCalledTimes(tries + 1)
    expect(failures()).toEqual(['g'])
    warn.mockRestore()
  })

  it('forgets the waiting redemptions and the retry at sign-out', async () => {
    vi.useFakeTimers({ now: 0 })
    cryptoService.ready = true
    member()
    crypto.redeemInvite.mockRejectedValueOnce(new CryptoError('Transport', 'offline'))
    await acceptInvite('c0de', 'seed')
    await vi.advanceTimersByTimeAsync(0)
    resetInvites()
    await vi.advanceTimersByTimeAsync(REDEEM_WAIT_MAX)
    expect(crypto.redeemInvite).toHaveBeenCalledOnce()
    crypto.redeemInvite.mockClear()

    cryptoService.ready = false
    await acceptInvite('c0de', 'seed')
    resetInvites()
    cryptoService.ready = true
    member()
    redeemWaitingInvites()
    expect(crypto.redeemInvite).not.toHaveBeenCalled()
  })
})
