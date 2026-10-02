import { describe, expect, it } from 'vitest'

import { CryptoError, type CryptoStore, type StoreSchema } from '../api'
import { toB64url } from '../codec'
import { createCryptoStore, STORE_TABLES, storeDatabaseName } from './index'
import { deserializeValue, serializeValue } from './serialize'

const ORIGIN = 'https://takusen.test'
let users = 0

function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function openStore(userId = `user-${++users}`, wrapKey?: CryptoKey): Promise<{ store: CryptoStore; userId: string; wrapKey: CryptoKey }> {
  const k = wrapKey ?? (await key())
  const store = createCryptoStore()
  await store.open({ origin: ORIGIN, userId, wrapKey: k })
  return { store, userId, wrapKey: k }
}

function rawDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(storeDatabaseName(ORIGIN, userId))
    r.onsuccess = () => {
      resolve(r.result)
    }
    r.onerror = () => {
      reject(r.error ?? new Error('open'))
    }
  })
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result)
    }
    r.onerror = () => {
      reject(r.error ?? new Error('request'))
    }
  })
}

async function rawGet(userId: string, table: string, k: string): Promise<Uint8Array> {
  const db = await rawDb(userId)
  try {
    return (await req(db.transaction(table, 'readonly').objectStore(table).get(k))) as Uint8Array
  } finally {
    db.close()
  }
}

async function rawPut(userId: string, table: string, k: string, v: Uint8Array): Promise<void> {
  const db = await rawDb(userId)
  try {
    await req(db.transaction(table, 'readwrite').objectStore(table).put(v, k))
  } finally {
    db.close()
  }
}

const identityRow = (): StoreSchema['identity'] => ({
  userId: 'u1',
  deviceId: 'd1',
  deviceCertificate: new Uint8Array([1, 2, 3]),
  mlsSignatureKey: { publicKey: new Uint8Array(32).fill(7), privateKey: new Uint8Array(32).fill(8) },
  hpkeKey: { publicKey: new Uint8Array(32).fill(9), privateKey: new Uint8Array(0) },
  dsk: null,
  master: { record: new Uint8Array([4]), privateKey: null },
  recoveryKeyId: null,
  dsExternalSender: new Uint8Array([5, 6]),
  ktPublicKey: null,
})

async function corrupt(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === 'StoreCorrupt')
}

describe('serialize', () => {
  it('round-trips plain data and Uint8Array, with sorted keys', () => {
    const v = { b: [1, 'x', null, true, new Uint8Array([0, 255])], a: { c: new Uint8Array(0) }, skip: undefined }
    const bytes = serializeValue(v)
    expect(new TextDecoder().decode(bytes)).toBe('{"a":{"c":{"$b":""}},"b":[1,"x",null,true,{"$b":"AP8"}]}')
    expect(deserializeValue(bytes)).toEqual({ a: { c: new Uint8Array(0) }, b: [1, 'x', null, true, new Uint8Array([0, 255])] })
    expect(serializeValue({ y: 1, x: 2 })).toEqual(serializeValue({ x: 2, y: 1 }))
  })

  it('rejects values that JSON would change silently', () => {
    for (const bad of [new Map(), new Set(), new Date(0), 1n, Number.NaN, Infinity, [undefined], { $b: 'x' }, () => 1]) {
      expect(() => serializeValue({ v: bad })).toThrow(CryptoError)
    }
  })
})

describe('CryptoStore', () => {
  it('round-trips every table, lists by prefix and deletes', async () => {
    const { store } = await openStore()
    await store.put('identity', 'self', identityRow())
    expect(await store.get('identity', 'self')).toEqual(identityRow())
    await store.put('seen', 'c1:a', { messageId: 'm1', sentAtMs: 10 })
    await store.put('seen', 'c1:b', { messageId: 'm2', sentAtMs: 11 })
    await store.put('seen', 'c2:a', { messageId: 'm3', sentAtMs: 12 })
    expect((await store.list('seen', 'c1:')).map((r) => r.key)).toEqual(['c1:a', 'c1:b'])
    expect(await store.list('seen')).toHaveLength(3)
    await store.delete('seen', 'c1:a')
    expect(await store.get('seen', 'c1:a')).toBeUndefined()
    expect(await store.get('groups', 'nothing')).toBeUndefined()
    for (const t of STORE_TABLES) expect(await store.list(t, 'zz')).toEqual([])
    store.close()
  })

  it('seals each write with a fresh nonce: the same value gives different records', async () => {
    const { store, userId } = await openStore()
    await store.put('inbox', 'self', { lastSeq: 1 })
    const a = await rawGet(userId, 'inbox', 'self')
    await store.put('inbox', 'self', { lastSeq: 1 })
    const b = await rawGet(userId, 'inbox', 'self')
    expect(a[0]).toBe(1)
    expect(toB64url(a.subarray(1, 13))).not.toBe(toB64url(b.subarray(1, 13)))
    // The plaintext is not visible in the record.
    expect(new TextDecoder().decode(a)).not.toContain('lastSeq')
    store.close()
  })

  it('commits a cross-table transaction atomically and rolls back on a throw', async () => {
    const { store } = await openStore()
    await store.put('groups', 'g1', { groupId: new Uint8Array([1]), state: new Uint8Array([2]), channelId: null, kind: 'dm', lastSeq: 0, status: 'active' })
    await expect(
      store.transaction(['groups', 'seen'], async (tx) => {
        await tx.put('seen', 'c:x', { messageId: 'm', sentAtMs: 1 })
        await tx.delete('groups', 'g1')
        expect(await tx.get('groups', 'g1')).toBeUndefined()
        expect(await tx.get('seen', 'c:x')).toEqual({ messageId: 'm', sentAtMs: 1 })
        expect((await tx.list('seen')).map((r) => r.key)).toEqual(['c:x'])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await store.get('seen', 'c:x')).toBeUndefined()
    expect(await store.get('groups', 'g1')).toBeDefined()

    const r = await store.transaction(['groups', 'seen'], async (tx) => {
      await tx.put('seen', 'c:x', { messageId: 'm', sentAtMs: 1 })
      await tx.delete('groups', 'g1')
      return 42
    })
    expect(r).toBe(42)
    expect(await store.get('seen', 'c:x')).toEqual({ messageId: 'm', sentAtMs: 1 })
    expect(await store.get('groups', 'g1')).toBeUndefined()

    await expect(store.transaction(['seen'], (tx) => tx.put('groups', 'g', null as never))).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === 'Malformed')
    store.close()
  })

  it('isolates concurrent read-modify-write transactions', async () => {
    const { store } = await openStore()
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.transaction(['inbox'], async (tx) => {
          const row = await tx.get('inbox', 'self')
          await tx.put('inbox', 'self', { lastSeq: (row?.lastSeq ?? 0) + 1 })
        }),
      ),
    )
    expect(await store.get('inbox', 'self')).toEqual({ lastSeq: 20 })
    store.close()
  })

  it('detects a changed record, and a record moved to another key or table', async () => {
    const { store, userId } = await openStore()
    await store.put('kt', 'self', { treeHead: null, lastSelfCheckMs: 1, lastSelfIndex: 2 })
    await store.put('kt', 'other', { treeHead: null, lastSelfCheckMs: 3, lastSelfIndex: 4 })
    await store.put('inbox', 'self', { lastSeq: 5 })
    const rec = await rawGet(userId, 'kt', 'self')

    // Moved to another key of the same table.
    await rawPut(userId, 'kt', 'other', rec)
    await corrupt(store.get('kt', 'other'))
    await corrupt(store.list('kt'))
    // Moved to the same key of another table.
    await rawPut(userId, 'inbox', 'self', rec)
    await corrupt(store.get('inbox', 'self'))
    // One flipped bit in the ciphertext, the nonce or the tag.
    for (const i of [5, 20, rec.length - 1]) {
      const bad = rec.slice()
      bad[i]! ^= 1
      await rawPut(userId, 'kt', 'self', bad)
      await corrupt(store.get('kt', 'self'))
    }
    // A wrong version byte, a truncated record, a record that is not bytes.
    const v2 = rec.slice()
    v2[0] = 2
    await rawPut(userId, 'kt', 'self', v2)
    await corrupt(store.get('kt', 'self'))
    await rawPut(userId, 'kt', 'self', rec.slice(0, 20))
    await corrupt(store.get('kt', 'self'))
    // The original record in its own place still opens.
    await rawPut(userId, 'kt', 'self', rec)
    expect(await store.get('kt', 'self')).toEqual({ treeHead: null, lastSelfCheckMs: 1, lastSelfIndex: 2 })
    store.close()
  })

  it('keeps users apart, and a record does not open under another wrap key', async () => {
    const a = await openStore()
    const b = await openStore()
    await a.store.put('inbox', 'self', { lastSeq: 1 })
    expect(await b.store.get('inbox', 'self')).toBeUndefined()
    // Same user, other wrap key (a lost or replaced key): the records do not open.
    const again = await openStore(a.userId, await key())
    await corrupt(again.store.get('inbox', 'self'))
    // A record of user a copied into user b's database: other key, no open.
    await rawPut(b.userId, 'inbox', 'self', await rawGet(a.userId, 'inbox', 'self'))
    await corrupt(b.store.get('inbox', 'self'))
    a.store.close()
    b.store.close()
    again.store.close()
  })

  it('destroy deletes the database, and the store opens empty again', async () => {
    const { store, userId } = await openStore()
    await store.put('inbox', 'self', { lastSeq: 9 })
    await store.destroy()
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(storeDatabaseName(ORIGIN, userId))
    expect(await store.get('inbox', 'self')).toBeUndefined()
    await store.put('inbox', 'self', { lastSeq: 1 })
    expect(await store.get('inbox', 'self')).toEqual({ lastSeq: 1 })
    store.close()
    await expect(store.get('inbox', 'self')).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === 'NotInitialized')
  })

  it('accepts only an AES-256-GCM wrap key', async () => {
    const store = createCryptoStore()
    const aes128 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt'])
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    for (const k of [aes128, hmac, {} as CryptoKey]) {
      await expect(store.open({ origin: ORIGIN, userId: 'k', wrapKey: k })).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === 'SecureStorageUnavailable')
    }
    await expect(store.get('inbox', 'self')).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === 'NotInitialized')
  })
})
