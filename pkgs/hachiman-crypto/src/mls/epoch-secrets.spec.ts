import { describe, expect, it, vi } from 'vitest'

import type { CryptoEvents, CryptoStore, DsTransport, EngineContext, HistoryKeyEntry, StoreSchema } from '../api'
import { toB64url } from '../codec'
import { randomBytes } from '../identity/bytes'
import { MemoryStore } from '../identity/test-helpers'
import { epochSecretKey, importEpochSecrets, markEpochSecretsBackedUp, putEpochSecretFromState, storedEpochSecrets } from './epoch-secrets'

/** Records the tables of each transaction. */
class TxStore extends MemoryStore {
  scopes: (keyof StoreSchema)[][] = []
  override async transaction<R>(tables: (keyof StoreSchema)[], fn: (tx: Pick<CryptoStore, 'get' | 'put' | 'delete' | 'list'>) => Promise<R>): Promise<R> {
    this.scopes.push(tables)
    return super.transaction(tables, fn)
  }
}

function world(): { store: TxStore; ctx: EngineContext; available: CryptoEvents['epochKeysAvailable'][] } {
  const store = new TxStore()
  const available: CryptoEvents['epochKeysAvailable'][] = []
  const ctx: EngineContext = {
    store,
    transport: {} as DsTransport,
    emit: (event, payload) => {
      if (event === 'epochKeysAvailable') available.push(payload as CryptoEvents['epochKeysAvailable'])
    },
    now: () => 0,
    random: randomBytes,
    origin: 'https://takusen.test',
    platform: 'electron',
    clientVersion: '1.0.0',
  }
  return { store, ctx, available }
}

const secret = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const entry = (groupId: Uint8Array, epoch: number, n: number): HistoryKeyEntry => ({ groupId, epoch, secret: secret(n) })

async function row(store: CryptoStore, groupId: Uint8Array, epoch: number): Promise<StoreSchema['epochSecrets'] | undefined> {
  return store.get('epochSecrets', `${toB64url(groupId)}:${epoch}`)
}

describe('epoch secrets (§12.11.1)', () => {
  it('keys a row by the base64url group id and the epoch', () => {
    expect(epochSecretKey('AQID', 7)).toBe('AQID:7')
  })

  it('an import never replaces a stored secret and emits only the added epochs, ascending, per group', async () => {
    const { store, ctx, available } = world()
    const g = new Uint8Array(22).fill(1)
    const h = new Uint8Array(22).fill(2)
    await store.put('epochSecrets', epochSecretKey(toB64url(g), 3), { groupId: g, epoch: 3, secret: secret(9), backedUp: false })
    await importEpochSecrets(ctx, [entry(g, 5, 1), entry(h, 2, 1), entry(g, 3, 1), entry(g, 1, 1)], true)
    expect(await row(store, g, 3)).toEqual({ groupId: g, epoch: 3, secret: secret(9), backedUp: false })
    expect(await row(store, g, 5)).toEqual({ groupId: g, epoch: 5, secret: secret(1), backedUp: true })
    expect(await row(store, h, 2)).toMatchObject({ backedUp: true })
    expect(available).toEqual([
      { groupId: toB64url(g), epochs: [1, 5] },
      { groupId: toB64url(h), epochs: [2] },
    ])
    expect(store.scopes).toEqual([['epochSecrets']])
    // Nothing to add: no event.
    await importEpochSecrets(ctx, [entry(g, 5, 2)], false)
    expect(await row(store, g, 5)).toMatchObject({ secret: secret(1), backedUp: true })
    expect(available).toHaveLength(2)
    await importEpochSecrets(ctx, [], false)
    expect(store.scopes).toHaveLength(2)
  })

  it('the secret from the MLS state replaces a stored secret that differs and is not backed up', async () => {
    const { store } = world()
    const g = new Uint8Array(22).fill(3)
    const gid = toB64url(g)
    expect(await putEpochSecretFromState(store, gid, g, 4, secret(1))).toBe(false)
    expect(await row(store, g, 4)).toEqual({ groupId: g, epoch: 4, secret: secret(1), backedUp: false })
    await store.put('epochSecrets', epochSecretKey(gid, 4), { groupId: g, epoch: 4, secret: secret(1), backedUp: true })
    expect(await putEpochSecretFromState(store, gid, g, 4, secret(2))).toBe(true)
    expect(await row(store, g, 4)).toEqual({ groupId: g, epoch: 4, secret: secret(2), backedUp: false })
    expect(store.scopes).toEqual([['epochSecrets'], ['epochSecrets']])
  })

  it('the secret from the MLS state that equals the stored secret changes nothing', async () => {
    const { store } = world()
    const g = new Uint8Array(22).fill(4)
    const gid = toB64url(g)
    await store.put('epochSecrets', epochSecretKey(gid, 0), { groupId: g, epoch: 0, secret: secret(5), backedUp: true })
    const put = vi.spyOn(store, 'put')
    expect(await putEpochSecretFromState(store, gid, g, 0, secret(5))).toBe(false)
    expect(put).not.toHaveBeenCalled()
    expect(await row(store, g, 0)).toMatchObject({ backedUp: true })
  })

  it('a backup flags only the rows whose secret did not change', async () => {
    const { store } = world()
    const g = new Uint8Array(22).fill(5)
    const gid = toB64url(g)
    await store.put('epochSecrets', epochSecretKey(gid, 0), { groupId: g, epoch: 0, secret: secret(1), backedUp: false })
    await store.put('epochSecrets', epochSecretKey(gid, 1), { groupId: g, epoch: 1, secret: secret(1), backedUp: false })
    const uploaded = [entry(g, 0, 1), entry(g, 1, 1), entry(g, 2, 1)]
    // The device enters epoch 1 during the upload: the MLS secret replaces the uploaded one.
    await putEpochSecretFromState(store, gid, g, 1, secret(2))
    await markEpochSecretsBackedUp(store, uploaded)
    expect(await row(store, g, 0)).toMatchObject({ secret: secret(1), backedUp: true })
    expect(await row(store, g, 1)).toMatchObject({ secret: secret(2), backedUp: false })
    // A missing row stays missing.
    expect(await row(store, g, 2)).toBeUndefined()
    expect(store.scopes.at(-1)).toEqual(['epochSecrets'])
  })

  it('a range read gives the same rows by key and by a list of the group', async () => {
    const { store } = world()
    const g = new Uint8Array(22).fill(6)
    const gid = toB64url(g)
    // A group whose id starts with the id of g: its rows are not in the range of g.
    const other = toB64url(new Uint8Array(23).fill(6))
    expect(other.startsWith(gid)).toBe(true)
    for (const e of [130, 2, 70, 5, 0, 69, 71]) await store.put('epochSecrets', epochSecretKey(gid, e), { groupId: g, epoch: e, secret: secret(e), backedUp: false })
    await store.put('epochSecrets', epochSecretKey(other, 3), { groupId: new Uint8Array(23).fill(6), epoch: 3, secret: secret(3), backedUp: false })
    const get = vi.spyOn(store, 'get')
    const list = vi.spyOn(store, 'list')

    // 64 epochs: one read per epoch.
    const byKey = await storedEpochSecrets(store, gid, 6, 69)
    expect(get).toHaveBeenCalledTimes(64)
    expect(list).not.toHaveBeenCalled()
    expect(byKey.map((k) => k.epoch)).toEqual([69])
    // 65 epochs: one list.
    get.mockClear()
    const byList = await storedEpochSecrets(store, gid, 6, 70)
    expect(get).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(1)
    expect(byList.map((k) => k.epoch)).toEqual([69, 70])

    for (const [from, to] of [
      [0, 5],
      [0, 63],
      [0, 64],
      [2, 71],
      [69, 71],
      [3, 1],
    ] as const) {
      const short = await storedEpochSecrets(store, gid, from, to)
      const all = (await storedEpochSecrets(store, gid, 0, Infinity)).filter((k) => k.epoch >= from && k.epoch <= to)
      expect(short).toEqual(all)
    }
    expect((await storedEpochSecrets(store, gid, 0, Infinity)).map((k) => k.epoch)).toEqual([0, 2, 5, 69, 70, 71, 130])
    expect(await storedEpochSecrets(store, gid, 0, 2)).toEqual([entry(g, 0, 0), entry(g, 2, 2)])
  })
})
