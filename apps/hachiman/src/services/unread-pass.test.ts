import type { Message } from '@hachiman/client'
import { describe, expect, it, vi } from 'vitest'
import { mentionPass, PASS_CHANNELS, PASS_CONCURRENCY, unreadTail } from '@/services/unread-pass'
import type { ChatMessage } from '@/stores/messagesStore'
import type { ChannelUnread } from '@/stores/unreadStore'

const msg = (channelId: string, id: string, text: string): Message =>
  ({ id, channelId, author: { id: 'other' }, envelope: text }) as unknown as Message

/** A fake decrypt: the envelope is the text; 'x' does not decrypt. */
const decrypt = async (ms: Message[]): Promise<ChatMessage[]> =>
  ms
    .filter((m) => m.envelope !== 'x')
    .map((m) => ({ id: m.id, content: m.envelope, decrypt: { status: 'ok' } }) as ChatMessage)

const entry = (lastReadId: string | null, unread: number): ChannelUnread => ({
  lastReadId,
  unread,
  mentions: 0,
  mentionIds: []
})

const history: Record<string, Message[]> = {
  lfg: [
    msg('lfg', 'l1', 'hi'),
    msg('lfg', 'l2', '@me old'),
    msg('lfg', 'l3', '@me new'),
    msg('lfg', 'l4', 'x')
  ],
  dm: [msg('dm', 'd1', '@me one'), msg('dm', 'd2', '@me two')],
  quiet: [msg('quiet', 'q1', '@me')]
}

describe('restart mention pass', () => {
  const deps = {
    fetchLatest: vi.fn(async (channelId: string) => history[channelId] ?? []),
    decrypt,
    mentionsMe: (r: ChatMessage) => r.content.includes('@me')
  }

  it('counts the mentions after the read point and skips read channels', async () => {
    const found = await mentionPass(
      [
        ['lfg', entry('l2', 2)],
        ['dm', entry('gone', 1)],
        ['quiet', entry('q1', 0)]
      ],
      deps
    )
    expect(found).toEqual(
      new Map([
        ['lfg', ['l3']],
        ['dm', ['d2']]
      ])
    )
    expect(deps.fetchLatest).not.toHaveBeenCalledWith('quiet', expect.anything())
  })

  it('takes at most 20 channels and survives a failing one', async () => {
    const fetchLatest = vi.fn(async (channelId: string) => {
      if (channelId === 'c0') throw new Error('boom')
      return [msg(channelId, `${channelId}-1`, '@me')]
    })
    const order = Array.from({ length: 30 }, (_, i): [string, ChannelUnread] => [
      `c${i}`,
      entry(null, 1)
    ])
    const found = await mentionPass(order, { ...deps, fetchLatest })
    expect(fetchLatest).toHaveBeenCalledTimes(PASS_CHANNELS)
    expect(found.size).toBe(PASS_CHANNELS - 1)
  })

  it('fetches a few channels at the same time and keeps the order', async () => {
    let running = 0
    let peak = 0
    const fetchLatest = vi.fn(async (channelId: string) => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, channelId === 'c0' ? 5 : 1))
      running--
      return [msg(channelId, `${channelId}-1`, '@me')]
    })
    const order = Array.from({ length: 10 }, (_, i): [string, ChannelUnread] => [
      `c${i}`,
      entry(null, 1)
    ])
    const found = await mentionPass(order, { ...deps, fetchLatest })
    expect(peak).toBe(PASS_CONCURRENCY)
    expect([...found.keys()]).toEqual(order.map(([id]) => id))
  })

  it('takes the messages after the read point, else the newest unread ones', () => {
    expect(unreadTail(history.lfg, 'l3', 9).map((m) => m.id)).toEqual(['l4'])
    expect(unreadTail(history.lfg, 'old', 2).map((m) => m.id)).toEqual(['l3', 'l4'])
  })
})
