/**
 * Read state (docs/gateway-protocol.md §4 POST /channels/:id/ack): forward
 * only in (created_at, id) order, the message must belong to the channel,
 * VIEW_CHANNEL, the rate limit, and READ_STATE_UPDATE to `user:{id}`. No DB /
 * Redis: a fake store, a counting rate limiter, captured publishes.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { Permissions } from '@hachiman/client/permissions'

import { ApiError, MissingPermissionsError, NotFoundError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'
import type { RateLimiter } from '@/lib/mls/context'
import { ACK_RATE_LIMIT, ackMessage, type ReadStateStore } from '@/lib/read-states'

const USER = '00000000-0000-4000-8000-000000000001'
const CH = '00000000-0000-4000-8000-0000000000c1'
const OTHER_CH = '00000000-0000-4000-8000-0000000000c2'
const VIEW = Permissions.VIEW_CHANNEL

interface Msg {
  id: string
  channelId: string
  createdAt: number
}

/** The order of the messages table: (created_at, id). */
const after = (a: Msg, b: Msg) => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)

function fakeStore(msgs: Msg[]): ReadStateStore & { state: Map<string, Msg> } {
  const byId = new Map(msgs.map((m) => [m.id, m]))
  const state = new Map<string, Msg>()
  return {
    state,
    async messageInChannel(channelId, messageId) {
      return byId.get(messageId)?.channelId === channelId
    },
    async advance(userId, channelId, messageId) {
      const m = byId.get(messageId)
      if (!m || m.channelId !== channelId) return false
      const key = `${userId}:${channelId}`
      const cur = state.get(key)
      if (cur && !after(m, cur)) return false
      state.set(key, m)
      return true
    },
  }
}

const noLimit: RateLimiter = { async hit() {} }

const M1 = { id: 'aaaaaaaa-0000-4000-8000-000000000001', channelId: CH, createdAt: 1 }
const M2 = { id: 'aaaaaaaa-0000-4000-8000-000000000002', channelId: CH, createdAt: 2 }
// Same time as M2, larger id: after M2.
const M3 = { id: 'aaaaaaaa-0000-4000-8000-000000000003', channelId: CH, createdAt: 2 }
const X1 = { id: 'bbbbbbbb-0000-4000-8000-000000000001', channelId: OTHER_CH, createdAt: 5 }

let published: { channel: string; payload: unknown }[] = []
beforeEach(() => {
  published = []
  setBusPublisher(async (channel, payload) => {
    published.push({ channel, payload: JSON.parse(payload) })
  })
})
afterEach(() => setBusPublisher(null))

const ack = (store: ReadStateStore, messageId: string, permissions = VIEW, rate = noLimit) =>
  ackMessage(store, rate, { userId: USER, channelId: CH, permissions, messageId })

describe('ackMessage', () => {
  test('moves forward and publishes READ_STATE_UPDATE to user:{id}', async () => {
    const store = fakeStore([M1, M2, M3])
    assert.equal(await ack(store, M1.id), true)
    assert.equal(await ack(store, M3.id), true)
    assert.deepEqual(published, [
      { channel: `user:${USER}`, payload: { t: 'READ_STATE_UPDATE', d: { channelId: CH, lastReadMessageId: M1.id } } },
      { channel: `user:${USER}`, payload: { t: 'READ_STATE_UPDATE', d: { channelId: CH, lastReadMessageId: M3.id } } },
    ])
  })

  test('ignores an ack for an older or the same message, also at the same created_at', async () => {
    const store = fakeStore([M1, M2, M3])
    await ack(store, M3.id)
    published = []
    for (const m of [M1, M2, M3]) assert.equal(await ack(store, m.id), false, m.id)
    assert.equal(store.state.get(`${USER}:${CH}`)?.id, M3.id)
    assert.deepEqual(published, [])
  })

  test('a message of another channel or an unknown message is 404', async () => {
    const store = fakeStore([M1, X1])
    await assert.rejects(ack(store, X1.id), NotFoundError)
    await assert.rejects(ack(store, 'cccccccc-0000-4000-8000-000000000001'), NotFoundError)
    assert.equal(store.state.size, 0)
    assert.deepEqual(published, [])
  })

  test('needs VIEW_CHANNEL', async () => {
    const store = fakeStore([M1])
    await assert.rejects(ack(store, M1.id, Permissions.SEND_MESSAGES), MissingPermissionsError)
    assert.equal(store.state.size, 0)
  })

  test('hits the ack rate limit per user and stops at 429', async () => {
    const hits: string[] = []
    const rate: RateLimiter = {
      async hit(bucket, subject, limit, windowSec) {
        hits.push(`${bucket}:${subject}:${limit}:${windowSec}`)
        if (hits.length > 1) throw new ApiError('RateLimited', 429, 'rate limit', undefined, 1)
      },
    }
    const store = fakeStore([M1, M2])
    await ack(store, M1.id, VIEW, rate)
    await assert.rejects(ack(store, M2.id, VIEW, rate), (e: unknown) => e instanceof ApiError && e.status === 429)
    assert.deepEqual(hits[0], `${ACK_RATE_LIMIT.bucket}:${USER}:${ACK_RATE_LIMIT.limit}:${ACK_RATE_LIMIT.windowSec}`)
    assert.equal(store.state.get(`${USER}:${CH}`)?.id, M1.id)
  })
})
