import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { User } from '@hachiman/client/types'

import { ApiError, NotFoundError, ValidationError } from '@/lib/errors'

import { pokeWith, type PokeDeps } from './poke'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

function world(opts: { shared?: boolean; blocked?: boolean } = {}) {
  const published: { target: string; user: User }[] = []
  const counts = new Map<string, number>()
  const deps: PokeDeps = {
    user: async (id) => (id === C ? null : { id, username: id.slice(-1), avatar: null }),
    sharesSpace: async () => opts.shared ?? true,
    blocked: async () => opts.blocked ?? false,
    rate: {
      async hit(bucket, subject, limit) {
        const key = `${bucket}:${subject}`
        const n = (counts.get(key) ?? 0) + 1
        counts.set(key, n)
        if (n > limit) throw new ApiError('RateLimited', 429, 'rate limit')
      },
    },
    publish: async (target, user) => void published.push({ target, user }),
  }
  return { deps, published }
}

describe('pokeWith', () => {
  test('publishes POKE with the sender to the target', async () => {
    const w = world()
    await pokeWith(w.deps, A, B)
    assert.deepEqual(w.published, [{ target: B, user: { id: A, username: 'a', avatar: null } }])
  })

  test('refuses yourself, an unknown user and a user without a shared guild or DM', async () => {
    await assert.rejects(pokeWith(world().deps, A, A), ValidationError)
    await assert.rejects(pokeWith(world().deps, A, C), NotFoundError)
    await assert.rejects(pokeWith(world({ shared: false }).deps, A, B), NotFoundError)
  })

  test('a block gives 403 Blocked and publishes nothing', async () => {
    const w = world({ blocked: true })
    await assert.rejects(pokeWith(w.deps, A, B), (e) => e instanceof ApiError && e.code === 'Blocked' && e.status === 403)
    assert.equal(w.published.length, 0)
  })

  test('a second poke of the same pair is rate limited', async () => {
    const w = world()
    await pokeWith(w.deps, A, B)
    await assert.rejects(pokeWith(w.deps, A, B), (e) => e instanceof ApiError && e.code === 'RateLimited')
    assert.equal(w.published.length, 1)
  })
})
