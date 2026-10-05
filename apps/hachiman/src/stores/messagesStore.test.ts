import { expect, it } from 'vitest'
import { dropHistory, messagesEpoch, useMessageStore, type ChatMessage } from './messagesStore'

const row = (id: string, pending = false): ChatMessage =>
  ({ id, channelId: 'c', createdAt: id, pending }) as unknown as ChatMessage

it('dropHistory keeps only unsent rows and forgets what was loaded', () => {
  const store = useMessageStore.getState()
  store.upsert('c', [row('1'), row('2')])
  store.addPending(row('3', true))
  store.upsert('d', [row('4')])
  store.setHasMore('c', true)
  const before = messagesEpoch()

  dropHistory()

  const s = useMessageStore.getState()
  expect(s.byChannel.get('c')?.map((m) => m.id)).toEqual(['3'])
  expect(s.byChannel.has('d')).toBe(false)
  expect(s.hasMore.size).toBe(0)
  expect(messagesEpoch()).toBe(before + 1)
})
