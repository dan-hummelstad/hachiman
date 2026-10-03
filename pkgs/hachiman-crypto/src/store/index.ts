/**
 * CryptoStore (docs/gateway-protocol.md §12.17): IndexedDB records sealed under the wrap key.
 *
 * - One database `hachiman-crypto:{origin}:{userId}`, one object store per StoreSchema table.
 * - A record is `uint8 version = 1 || nonce[12] || AES-256-GCM(wrapKey, nonce, aad, value)`, with a
 *   random nonce per write and aad = encode(struct { opaque table<V>; opaque key<V>; }). A record
 *   that is changed, or moved to another table or key, does not open: CryptoError('StoreCorrupt').
 * - The wrap key is used directly. A non-extractable AES-GCM key cannot be an HKDF input.
 *
 * IndexedDB commits a transaction when it has no open request, and WebCrypto calls are not
 * requests. So transaction() runs `fn` against a write overlay, seals the writes, and then applies
 * them in one readwrite IndexedDB transaction. Writes (put, delete, transaction) run one at a time,
 * so a read-modify-write in a transaction sees no other write. Thus `fn` must use `tx`, never the
 * store itself, or it waits for itself.
 */
import { CryptoError, type CryptoStore, type StoreSchema, type UserId } from '../api'
import { encode } from '../codec'
import { deserializeValue, serializeValue } from './serialize'

type Table = keyof StoreSchema
type Tx = Pick<CryptoStore, 'get' | 'put' | 'delete' | 'list'>

const TABLE_SET = {
  identity: true,
  groups: true,
  epochSecrets: true,
  keyPackages: true,
  seen: true,
  contacts: true,
  kt: true,
  buffered: true,
  inbox: true,
  pendingCommits: true,
  adminState: true,
  timeline: true,
  membership: true,
  aeadFailures: true,
} as const satisfies Record<Table, true>
export const STORE_TABLES = Object.keys(TABLE_SET) as Table[]

/** Raise when a table is added: onupgradeneeded creates the missing object stores. */
const DB_VERSION = 1
const RECORD_VERSION = 1
const NONCE_LENGTH = 12
const TAG_LENGTH = 16

export function storeDatabaseName(origin: string, userId: UserId): string {
  return `hachiman-crypto:${origin}:${userId}`
}

function recordAad(table: string, key: string): Uint8Array<ArrayBuffer> {
  const b = encode((w) => w.utf8(table).utf8(key))
  return new Uint8Array(b)
}

function checkTable(table: string): asserts table is Table {
  if (!Object.hasOwn(TABLE_SET, table)) throw new CryptoError('Malformed', `store: unknown table ${table}`)
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new CryptoError('Malformed', 'store: empty key')
}

function idbFactory(): IDBFactory {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (f === undefined) throw new CryptoError('SecureStorageUnavailable', 'IndexedDB is not available')
  return f
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result)
    }
    r.onerror = () => {
      reject(new CryptoError('SecureStorageUnavailable', `IndexedDB: ${r.error?.message ?? 'request failed'}`))
    }
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    const fail = (): void => {
      reject(new CryptoError('SecureStorageUnavailable', `IndexedDB: ${tx.error?.message ?? 'transaction aborted'}`))
    }
    tx.onerror = fail
    tx.onabort = fail
  })
}

function prefixRange(prefix: string): IDBKeyRange | undefined {
  // Every key that starts with `prefix` sorts in [prefix, prefix + U+FFFF]. The startsWith filter stays.
  return prefix === '' ? undefined : IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff))
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  throw new CryptoError('StoreCorrupt', 'store: record is not bytes')
}

const DELETED = Symbol('deleted')

interface Config {
  name: string
  wrapKey: CryptoKey
}

class IdbCryptoStore implements CryptoStore {
  private config: Config | null = null
  private db: Promise<IDBDatabase> | null = null
  private writes: Promise<unknown> = Promise.resolve()

  async open(input: { origin: string; userId: UserId; wrapKey: CryptoKey }): Promise<void> {
    const k = input.wrapKey as Partial<CryptoKey> | undefined
    const alg = k?.algorithm as Partial<AesKeyAlgorithm> | undefined
    if (alg?.name !== 'AES-GCM' || alg.length !== 256 || !k?.usages?.includes('encrypt') || !k.usages.includes('decrypt')) {
      throw new CryptoError('SecureStorageUnavailable', 'the wrap key must be an AES-256-GCM key for encrypt and decrypt')
    }
    const name = storeDatabaseName(input.origin, input.userId)
    if (this.config?.name !== name) this.close()
    this.config = { name, wrapKey: input.wrapKey }
    await this.database()
  }

  private requireConfig(): Config {
    if (this.config === null) throw new CryptoError('NotInitialized', 'store: call open first')
    return this.config
  }

  /** Opens lazily, so the store works again after destroy() or a versionchange close. */
  private database(): Promise<IDBDatabase> {
    const { name } = this.requireConfig()
    if (this.db !== null) return this.db
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const r = idbFactory().open(name, DB_VERSION)
      r.onupgradeneeded = () => {
        const db = r.result
        for (const t of STORE_TABLES) if (!db.objectStoreNames.contains(t)) db.createObjectStore(t)
      }
      // onblocked: another connection gets versionchange and closes (see onsuccess). Then open goes on.
      r.onerror = () => {
        reject(new CryptoError('SecureStorageUnavailable', `IndexedDB: ${r.error?.message ?? 'open failed'}`))
      }
      r.onsuccess = () => {
        const db = r.result
        db.onversionchange = () => {
          db.close()
          if (this.db === p) this.db = null
        }
        resolve(db)
      }
    })
    this.db = p
    p.catch(() => {
      if (this.db === p) this.db = null
    })
    return p
  }

  /** Writes run in call order, one at a time. */
  private exclusive<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.writes.then(fn, fn)
    this.writes = run.catch(() => undefined)
    return run
  }

  private async seal(table: Table, key: string, plain: Uint8Array): Promise<Uint8Array> {
    const { wrapKey } = this.requireConfig()
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: recordAad(table, key), tagLength: 128 }, wrapKey, new Uint8Array(plain)))
    const out = new Uint8Array(1 + NONCE_LENGTH + ct.length)
    out[0] = RECORD_VERSION
    out.set(nonce, 1)
    out.set(ct, 1 + NONCE_LENGTH)
    return out
  }

  private async open_(table: Table, key: string, raw: unknown): Promise<unknown> {
    const { wrapKey } = this.requireConfig()
    const b = asBytes(raw)
    if (b.length < 1 + NONCE_LENGTH + TAG_LENGTH || b[0] !== RECORD_VERSION) throw new CryptoError('StoreCorrupt', `store: bad record ${table}/${key}`)
    let plain: ArrayBuffer
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b.slice(1, 1 + NONCE_LENGTH), additionalData: recordAad(table, key), tagLength: 128 },
        wrapKey,
        b.slice(1 + NONCE_LENGTH),
      )
    } catch {
      throw new CryptoError('StoreCorrupt', `store: record ${table}/${key} does not open`)
    }
    return deserializeValue(new Uint8Array(plain))
  }

  private async readOne(table: Table, key: string): Promise<unknown> {
    const db = await this.database()
    const raw: unknown = await request(db.transaction(table, 'readonly').objectStore(table).get(key))
    return raw === undefined ? undefined : this.open_(table, key, raw)
  }

  private async readMany(table: Table, prefix: string): Promise<{ key: string; value: unknown }[]> {
    const db = await this.database()
    const os = db.transaction(table, 'readonly').objectStore(table)
    const range = prefixRange(prefix)
    const [keys, values] = await Promise.all([request(os.getAllKeys(range)), request(os.getAll(range))])
    if (keys.length !== values.length) throw new CryptoError('StoreCorrupt', 'store: key and value lists differ')
    const out: { key: string; value: unknown }[] = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (typeof key !== 'string') throw new CryptoError('StoreCorrupt', `store: non-string key in ${table}`)
      if (!key.startsWith(prefix)) continue
      out.push({ key, value: await this.open_(table, key, values[i]) })
    }
    return out
  }

  /** Seals every write first, then applies all of them in one readwrite transaction. */
  private async commit(writes: Map<Table, Map<string, Uint8Array | typeof DELETED>>): Promise<void> {
    const sealed: { table: Table; key: string; record: Uint8Array | null }[] = []
    for (const [table, rows] of writes) {
      for (const [key, v] of rows) sealed.push({ table, key, record: v === DELETED ? null : await this.seal(table, key, v) })
    }
    if (sealed.length === 0) return
    const db = await this.database()
    const tx = db.transaction([...writes.keys()], 'readwrite')
    const finished = done(tx)
    for (const w of sealed) {
      const os = tx.objectStore(w.table)
      if (w.record === null) os.delete(w.key)
      else os.put(w.record, w.key)
    }
    await finished
  }

  async get<T extends Table>(table: T, key: string): Promise<StoreSchema[T] | undefined> {
    checkTable(table)
    checkKey(key)
    return (await this.readOne(table, key)) as StoreSchema[T] | undefined
  }

  put<T extends Table>(table: T, key: string, value: StoreSchema[T]): Promise<void> {
    checkTable(table)
    checkKey(key)
    const plain = serializeValue(value)
    return this.exclusive(() => this.commit(new Map([[table, new Map([[key, plain]])]])))
  }

  delete(table: Table, key: string): Promise<void> {
    checkTable(table)
    checkKey(key)
    const rows = new Map<string, Uint8Array | typeof DELETED>([[key, DELETED]])
    return this.exclusive(() => this.commit(new Map([[table, rows]])))
  }

  async list<T extends Table>(table: T, prefix = ''): Promise<{ key: string; value: StoreSchema[T] }[]> {
    checkTable(table)
    return (await this.readMany(table, prefix)) as { key: string; value: StoreSchema[T] }[]
  }

  transaction<R>(tables: Table[], fn: (tx: Tx) => Promise<R>): Promise<R> {
    if (tables.length === 0) return Promise.reject(new CryptoError('Malformed', 'store: a transaction needs a table'))
    for (const t of tables) checkTable(t)
    const scope = new Set<Table>(tables)
    return this.exclusive(async () => {
      const writes = new Map<Table, Map<string, Uint8Array | typeof DELETED>>()
      let active = true
      const use = (table: Table): void => {
        if (!active) throw new CryptoError('Malformed', 'store: the transaction is over')
        checkTable(table)
        if (!scope.has(table)) throw new CryptoError('Malformed', `store: ${table} is not in the transaction`)
      }
      const overlay = (table: Table): Map<string, Uint8Array | typeof DELETED> => {
        let m = writes.get(table)
        if (m === undefined) writes.set(table, (m = new Map<string, Uint8Array | typeof DELETED>()))
        return m
      }
      const tx: Tx = {
        get: async <T extends Table>(table: T, key: string) => {
          use(table)
          checkKey(key)
          const w = writes.get(table)?.get(key)
          if (w === DELETED) return undefined
          if (w !== undefined) return deserializeValue(w) as StoreSchema[T]
          return (await this.readOne(table, key)) as StoreSchema[T] | undefined
        },
        put: <T extends Table>(table: T, key: string, value: StoreSchema[T]) => {
          use(table)
          checkKey(key)
          overlay(table).set(key, serializeValue(value))
          return Promise.resolve()
        },
        delete: (table: Table, key: string) => {
          use(table)
          checkKey(key)
          overlay(table).set(key, DELETED)
          return Promise.resolve()
        },
        list: async <T extends Table>(table: T, prefix = '') => {
          use(table)
          const rows = new Map((await this.readMany(table, prefix)).map((r) => [r.key, r.value]))
          for (const [key, w] of writes.get(table) ?? []) {
            if (!key.startsWith(prefix)) continue
            if (w === DELETED) rows.delete(key)
            else rows.set(key, deserializeValue(w))
          }
          return [...rows.keys()].sort().map((key) => ({ key, value: rows.get(key) as StoreSchema[T] }))
        },
      }
      try {
        const result = await fn(tx)
        await this.commit(writes)
        return result
      } finally {
        active = false
      }
    })
  }

  async destroy(): Promise<void> {
    const { name } = this.requireConfig()
    await this.exclusive(async () => {
      const db = this.db
      this.db = null
      if (db !== null) (await db.catch(() => null))?.close()
      await new Promise<void>((resolve, reject) => {
        const r = idbFactory().deleteDatabase(name)
        r.onsuccess = () => {
          resolve()
        }
        r.onerror = () => {
          reject(new CryptoError('SecureStorageUnavailable', `IndexedDB: ${r.error?.message ?? 'delete failed'}`))
        }
      })
    })
  }

  close(): void {
    const db = this.db
    this.db = null
    this.config = null
    void db?.then((d) => {
      d.close()
    }, () => undefined)
  }
}

export function createCryptoStore(): CryptoStore {
  return new IdbCryptoStore()
}
