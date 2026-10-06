import { afterEach, expect, it, vi } from 'vitest'

const rest = { createInvite: vi.fn((_guildId: string, body: unknown) => Promise.resolve(body)) }
vi.mock('@/services/hachiman', () => ({ hachiman: { rest } }))

const { createInvite, DEFAULT_INVITE_OPTIONS } = await import('./InviteService')

afterEach(() => {
  rest.createInvite.mockClear()
})

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
