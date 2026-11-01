import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IdMap, snowflakeAt } from './ids'
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
  it('gives a dated snowflake once, and keeps it across a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hb-ids-'))
    const a = new IdMap(dir)
    const snow = a.snowflake('00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000Z')
    expect(Number((BigInt(snow) >> 22n) + 1420070400000n)).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(a.snowflake('00000000-0000-4000-8000-000000000001')).toBe(snow)
    a.flush()
    const b = new IdMap(dir)
    expect(b.uuid(snow)).toBe('00000000-0000-4000-8000-000000000001')
    expect(b.snowflake('00000000-0000-4000-8000-000000000002', '2026-01-01T00:00:00.000Z')).not.toBe(snow)
  })

  it('never gives one snowflake to two ids', () => {
    expect(snowflakeAt(Date.parse('2026-01-01T00:00:00.000Z'), 0n)).not.toBe(
      snowflakeAt(Date.parse('2026-01-01T00:00:00.000Z'), 1n),
    )
  })
})
