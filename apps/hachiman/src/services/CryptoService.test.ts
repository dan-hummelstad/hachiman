import type { CryptoClient, CryptoGatewayEvent, CryptoStatus } from '@hachiman/crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { useCryptoStore } from '@/stores/cryptoStore'
import { cryptoService } from './CryptoService'

const link = {
  t: 'DEVICE_LINK',
  d: { sessionId: 's', seq: 1, fromDevice: 'old' }
} as CryptoGatewayEvent
const handshake = { t: 'MLS_HANDSHAKE', d: {} } as CryptoGatewayEvent

/** A started Worker whose identity is in `state`. Returns the events it received. */
function worker(state: CryptoStatus['state']): CryptoGatewayEvent[] {
  const seen: CryptoGatewayEvent[] = []
  const fake = {
    onGatewayEvent: (e: CryptoGatewayEvent) => {
      seen.push(e)
      return Promise.resolve()
    }
  } as unknown as CryptoClient
  ;(cryptoService as unknown as { current: CryptoClient | null }).current = fake
  useCryptoStore.setState({ phase: 'ready', status: { state } as CryptoStatus })
  return seen
}

afterEach(() => {
  ;(cryptoService as unknown as { current: CryptoClient | null }).current = null
  vi.restoreAllMocks()
})

it('a linking device gets DEVICE_LINK, so the link reaches the emoji and the transfer', () => {
  const seen = worker('linking')
  cryptoService.onGatewayEvent(link)
  cryptoService.onGatewayEvent(handshake)
  expect(seen).toEqual([link]) // group events still wait for 'ready' (sync catches up)
})

it('a ready device gets every event', () => {
  const seen = worker('ready')
  cryptoService.onGatewayEvent(link)
  cryptoService.onGatewayEvent(handshake)
  expect(seen).toEqual([link, handshake])
})

it('nothing goes to a Worker that has not started', () => {
  const seen = worker('linking')
  useCryptoStore.setState({ phase: 'starting' })
  cryptoService.onGatewayEvent(link)
  expect(seen).toEqual([])
})
