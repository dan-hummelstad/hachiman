import type { CryptoStatus, DsTransport } from '@hachiman/crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { IPlatformService } from '@/shared/IPlatformService'
import { useCryptoStore } from '@/stores/cryptoStore'

/** Each createCryptoClient call returns the next fake; init resolves with its state. */
const states: CryptoStatus['state'][] = []
const wipes = vi.fn(() => Promise.resolve())
vi.mock('@hachiman/crypto', async (orig) => ({
  ...(await orig<typeof import('@hachiman/crypto')>()),
  createCryptoClient: () => ({
    on: () => () => undefined,
    init: () =>
      Promise.resolve({ state: states.shift(), deviceId: null } as unknown as CryptoStatus),
    signOutDevice: wipes,
    dispose: () => undefined
  })
}))

const { cryptoService } = await import('./CryptoService')
const { takusenService } = await import('./TakusenService')

const platform = {
  platform: 'electron',
  secureStorage: { getWrapKey: () => Promise.resolve({} as CryptoKey) }
} as unknown as IPlatformService
const opts = { userId: 'u', platform, transport: {} as DsTransport }

afterEach(() => {
  cryptoService.stop()
  wipes.mockClear()
  vi.restoreAllMocks()
})

it('a device that the DS removed starts over at sign-in instead of signing out again', async () => {
  const signOut = vi.spyOn(takusenService, 'signOut').mockImplementation(() => undefined)
  states.push('revoked', 'needs_identity')
  await cryptoService.start(opts)
  expect(wipes).toHaveBeenCalledOnce()
  expect(useCryptoStore.getState().status?.state).toBe('needs_identity')
  expect(useCryptoStore.getState().fatal).toBeNull()
  expect(signOut).not.toHaveBeenCalled()
})

it('a failed wipe fails the start (error screen) instead of starting again', async () => {
  const signOut = vi.spyOn(takusenService, 'signOut').mockImplementation(() => undefined)
  wipes.mockRejectedValueOnce(new Error('store busy'))
  states.push('revoked')
  await cryptoService.start(opts)
  expect(useCryptoStore.getState().phase).toBe('error')
  expect(useCryptoStore.getState().fatal).toBeNull()
  expect(signOut).not.toHaveBeenCalled()
})

it('a revocation while the app runs still signs out', async () => {
  const signOut = vi.spyOn(takusenService, 'signOut').mockImplementation(() => undefined)
  states.push('ready')
  await cryptoService.start(opts)
  ;(cryptoService as unknown as { setStatus(s: CryptoStatus): void }).setStatus({
    state: 'revoked'
  } as CryptoStatus)
  expect(useCryptoStore.getState().fatal).toBe('device_revoked')
  expect(signOut).toHaveBeenCalledOnce()
})
