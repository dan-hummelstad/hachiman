import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IdMap, shardOfGuild, snowflakeAt } from './ids'
import { ensureDeploymentKey, openLinkPayload, readDeploymentKey, sealLinkPayload } from './link'
import { FileCryptoStore } from './store'

const key = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const open = async (dir: string, wrapKey: CryptoKey): Promise<FileCryptoStore> => {
  const s = new FileCryptoStore(dir)
  await s.open({ origin: 'https://h.test', userId: 'u1', wrapKey })
  return s
}

describe('FileCryptoStore', () => {
  it('keeps records across a reopen, encrypted on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hb-store-'))
    const k = await key()
    const a = await open(dir, k)
    await a.put('identity', 'self', {
      secret: new Uint8Array([1, 2, 3]),
      name: 'needle-in-plaintext',
    } as never)
    const b = await open(dir, k)
    expect(await b.get('identity', 'self')).toEqual({
      secret: new Uint8Array([1, 2, 3]),
      name: 'needle-in-plaintext',
    })
    expect((await readFile(join(dir, 'crypto-u1.bin'))).includes(Buffer.from('needle'))).toBe(false)
  })

  it('refuses another wrap key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hb-store-'))
    await (await open(dir, await key())).put('identity', 'self', { a: 1 } as never)
    await expect(open(dir, await key())).rejects.toMatchObject({
      code: 'StoreCorrupt',
    })
  })

  it('applies a transaction whole, or not at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hb-store-'))
    const s = await open(dir, await key())
    await s.put('groups', 'g1', { epoch: 1 } as never)
    await expect(
      s.transaction(['groups'], async tx => {
        await tx.put('groups', 'g1', { epoch: 2 } as never)
        expect(await tx.get('groups', 'g1')).toEqual({ epoch: 2 })
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(await s.get('groups', 'g1')).toEqual({ epoch: 1 })

    await s.transaction(['groups'], async tx => {
      await tx.put('groups', 'g2', { epoch: 5 } as never)
      await tx.delete('groups', 'g1')
      expect((await tx.list('groups')).map(r => r.key)).toEqual(['g2'])
      // A write outside the transaction while it runs does not deadlock.
      await s.put('seen', 'x', { at: 1 } as never)
    })
    expect((await s.list('groups')).map(r => r.key)).toEqual(['g2'])
    expect(await s.get('seen', 'x')).toEqual({ at: 1 })
  })
})

describe('IdMap', () => {
  const A = '00000000-0000-4000-8000-000000000001'
  const B = '00000000-0000-4000-8000-000000000002'
  const AT = '2026-01-01T00:00:00.000Z'

  it('gives the same snowflakes in every run, with the creation time when known', () => {
    const run1 = new IdMap()
    const run2 = new IdMap()
    const dated = run1.snowflake(A, AT)
    expect(run2.snowflake(A, AT)).toBe(dated)
    expect(Number((BigInt(dated) >> 22n) + 1420070400000n)).toBe(Date.parse(AT))
    expect(run1.snowflake(B)).toBe(run2.snowflake(B))
    expect(BigInt(run1.snowflake(B)) < 1n << 63n).toBe(true)
    expect(run1.snowflake(B, AT)).toBe(run1.snowflake(B))
  })

  it('answers the reverse lookup for the ids it gave out', () => {
    const ids = new IdMap()
    const snow = ids.snowflake(A, AT)
    expect(ids.uuid(snow)).toBe(A)
    expect(ids.uuid('12345')).toBeNull()
  })

  it('never gives one snowflake to two ids', () => {
    expect(snowflakeAt(Date.parse(AT), 0n)).not.toBe(snowflakeAt(Date.parse(AT), 1n))
  })
})

describe('link payload', () => {
  const key = (): Promise<CryptoKey> =>
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

  it('opens with the same deployment key and bot only', async () => {
    const k = await key()
    const blob = await sealLinkPayload(k, 'bot-1', 'hachiman-link:1:abc')
    expect(await openLinkPayload(k, 'bot-1', blob)).toBe('hachiman-link:1:abc')
    expect(await openLinkPayload(await key(), 'bot-1', blob)).toBeNull()
    expect(await openLinkPayload(k, 'bot-2', blob)).toBeNull()
    expect(Buffer.from(blob, 'base64url').includes(Buffer.from('hachiman-link'))).toBe(false)
  })

  it('makes the deployment key once, and every shard reads the same one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hb-deploy-'))
    expect(await readDeploymentKey(dir)).toBeNull()
    const [a, b] = await Promise.all([ensureDeploymentKey(dir), ensureDeploymentKey(dir)])
    const blob = await sealLinkPayload(a.key, 'bot-1', 'x'.repeat(40))
    expect(await openLinkPayload(b.key, 'bot-1', blob)).toBe('x'.repeat(40))
    expect((await ensureDeploymentKey(dir)).made).toBe(false)
  })
})

describe('shardOfGuild', () => {
  it("is Discord's (guild_id >> 22) % shard_count", () => {
    const at = '2026-01-01T00:00:00.123Z'
    const ids = new IdMap()
    const snow = BigInt(ids.snowflake('00000000-0000-4000-8000-0000000000aa', at))
    expect(shardOfGuild(at, 4)).toBe(Number((snow >> 22n) % 4n))
  })
})
