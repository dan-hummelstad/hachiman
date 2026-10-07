/**
 * Pinned messages (N13, contract §4 Pins). GET /channels/:id/pins gives ciphertext Messages: they
 * go through their own MessageDecryptor (decrypt before store) into pinsStore, not into the
 * transcript. CHANNEL_PINS_UPDATE loads a loaded channel again.
 */
import type { Message, RestClient } from '@hachiman/client'
import { createMessageDecryptor, type DecryptorDeps } from '@/services/message-decrypt'
import { resetPinsStore, usePinsStore } from '@/stores/pinsStore'

export interface PinsDeps {
  rest: Pick<RestClient, 'getPins' | 'pinMessage' | 'unpinMessage'>
  decrypt: DecryptorDeps['decrypt']
}

export interface PinsService {
  /** Loads the pins of a channel (again). Never rejects (logs). */
  list(channelId: string): Promise<void>
  /** Loads the pins unless they are loaded. */
  ensureLoaded(channelId: string): void
  /** Rejects with the RestError (400 TooManyPins past 50, 403 without MANAGE_MESSAGES). */
  pin(channelId: string, messageId: string): Promise<void>
  unpin(channelId: string, messageId: string): Promise<void>
  /** CHANNEL_PINS_UPDATE. */
  onPinsUpdate(channelId: string): void
  retryGroup(groupId: string): void
  retryAll(): void
  reset(): void
}

export function createPinsService(deps: PinsDeps): PinsService {
  const decryptor = createMessageDecryptor({
    decrypt: deps.decrypt,
    existing: (channelId, messageId) =>
      usePinsStore
        .getState()
        .byChannel.get(channelId)
        ?.find((m) => m.id === messageId),
    upsert: (channelId, rows) => usePinsStore.getState().upsertRows(channelId, rows)
  })
  /** channelId → the number of the newest list call, so an older response is dropped. */
  const calls = new Map<string, number>()
  let generation = 0

  const service: PinsService = {
    async list(channelId) {
      const started = generation
      const call = (calls.get(channelId) ?? 0) + 1
      calls.set(channelId, call)
      let page: Message[]
      try {
        page = await deps.rest.getPins(channelId)
      } catch (e) {
        console.warn('[pins] load failed', e)
        return
      }
      if (started !== generation || calls.get(channelId) !== call) return
      usePinsStore.getState().setOrder(
        channelId,
        page.map((m) => m.id)
      )
      await decryptor.ingest(page)
    },
    ensureLoaded(channelId) {
      if (!usePinsStore.getState().order.has(channelId) && !calls.has(channelId))
        void service.list(channelId)
    },
    async pin(channelId, messageId) {
      await deps.rest.pinMessage(channelId, messageId)
    },
    async unpin(channelId, messageId) {
      await deps.rest.unpinMessage(channelId, messageId)
    },
    onPinsUpdate(channelId) {
      if (usePinsStore.getState().order.has(channelId) || calls.has(channelId))
        void service.list(channelId)
    },
    retryGroup: (groupId) => void decryptor.retryGroup(groupId),
    retryAll: () => void decryptor.retryAll(),
    reset() {
      generation++
      calls.clear()
      decryptor.reset()
      resetPinsStore()
    }
  }
  return service
}
