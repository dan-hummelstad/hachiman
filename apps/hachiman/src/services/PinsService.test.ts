import { beforeEach, expect, it, vi } from 'vitest'
import type { Message } from '@hachiman/client'
import type { DecryptResult, EncryptedMessage } from '@hachiman/crypto'
import { resetPinsStore, usePinsStore } from '@/stores/pinsStore'
import { createPinsService } from './PinsService'

const wire = (id: string): Message => ({
  id,
  channelId: 'c-1',
  guildId: 'g-1',
  author: { id: 'u-1', username: 'a', avatar: null },
  senderDevice: 'd-1',
  groupId: 'grp',
  epoch: 1,
  clientMsgId: `cmid-${id}`,
  envelope: `ENV-${id}`,
  attachments: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  editedAt: null
})

const decrypt = async (ms: EncryptedMessage[]): Promise<DecryptResult[]> =>
  ms.map((m) => ({
    status: 'ok',
    messageId: m.id,
    clientMsgId: m.clientMsgId,
    kind: 'message',
    editOf: null,
    content: { text: `text ${m.id}`, mentions: [], attachments: [], replyTo: null, linkPreview: null, sentAtMs: 1 },
    sender: {
      userId: m.authorId,
      deviceId: 'd-1',
      leafIndex: 0,
      trust: 'tofu',
      membershipVerified: true
    }
  }))

const state = (): ReturnType<typeof usePinsStore.getState> => usePinsStore.getState()

beforeEach(() => resetPinsStore())

it('lists decrypted pins newest first, and loads again on CHANNEL_PINS_UPDATE', async () => {
  let pinned = ['m2', 'm1']
  const getPins = vi.fn(async () => pinned.map(wire))
  const pins = createPinsService({
    rest: { getPins, pinMessage: vi.fn(), unpinMessage: vi.fn() },
    decrypt
  })
  pins.onPinsUpdate('c-1') // not loaded: no fetch
  expect(getPins).not.toHaveBeenCalled()

  await pins.list('c-1')
  expect(
    state()
      .byChannel.get('c-1')
      ?.map((m) => m.content)
  ).toEqual(['text m2', 'text m1'])
  expect(JSON.stringify([...state().byChannel.values()])).not.toContain('ENV-')

  pinned = ['m3', 'm2', 'm1']
  pins.onPinsUpdate('c-1')
  await vi.waitFor(() =>
    expect(
      state()
        .byChannel.get('c-1')
        ?.map((m) => m.id)
    ).toEqual(['m3', 'm2', 'm1'])
  )
  expect(getPins).toHaveBeenCalledTimes(2)
})

it('drops the response of an older list call', async () => {
  const resolvers: ((ms: Message[]) => void)[] = []
  const getPins = vi.fn(() => new Promise<Message[]>((r) => resolvers.push(r)))
  const pins = createPinsService({
    rest: { getPins, pinMessage: vi.fn(), unpinMessage: vi.fn() },
    decrypt
  })
  const first = pins.list('c-1')
  const second = pins.list('c-1')
  resolvers[1]([wire('new')])
  await second
  resolvers[0]([wire('old')])
  await first
  expect(state().order.get('c-1')).toEqual(['new'])
})
