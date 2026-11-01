/**
 * A `CryptoStore` (§12.17) on disk, for a bot in Node: the browser hosts use IndexedDB, which Node
 * does not have. All tables live in one file, `crypto-<userId>.bin` in the state directory:
 * `0x01 ‖ nonce[12] ‖ AES-256-GCM(wrapKey, serializeValue(tables))`, AAD = the store id. Each write
 * replaces the file (temp file, fsync, rename), so a crash leaves the old or the new state, never a
 * mix. A write resolves only after the file is on disk: the engine must not send with a ratchet
 * state that a restart would lose.
 */
// ponytail: the whole state is rewritten on each write; split it per table if a bot's store grows past a few MB.
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CryptoStore, StoreSchema } from '@hachiman/crypto'
import { deserializeValue, serializeValue } from '@hachiman/crypto/host'

type Tables = Map<string, Map<string, unknown>>
type Tx = Pick<CryptoStore, 'get' | 'put' | 'delete' | 'list'>

const VERSION = 1
const DELETED = Symbol('deleted')

function tablesFrom(v: unknown): Tables {
  const out: Tables = new Map()
  for (const [name, rows] of Object.entries((v ?? {}) as Record<string, Record<string, unknown>>))
    out.set(name, new Map(Object.entries(rows)))
  return out
}

function tablesTo(t: Tables): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, rows] of t) out[name] = Object.fromEntries(rows)
  return out
}

export class FileCryptoStore implements CryptoStore {
  private tables: Tables = new Map()
  private key: CryptoKey | null = null
  private path = ''
  private aad = new Uint8Array()
  /** File writes run one at a time, in order. */
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  async open(input: { origin: string; userId: string; wrapKey: CryptoKey }): Promise<void> {
    const alg = input.wrapKey.algorithm as AesKeyAlgorithm
    if (alg.name !== 'AES-GCM' || alg.length !== 256)
      throw new Error('store: the wrap key is not AES-GCM-256')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    this.key = input.wrapKey
    this.path = join(this.dir, `crypto-${input.userId}.bin`)
    this.aad = new TextEncoder().encode(`hachiman-bot-store:${VERSION}:${input.origin}:${input.userId}`)
    let file: Uint8Array
    try {
      file = new Uint8Array(await readFile(this.path))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.tables = new Map()
      return
    }
    if (file[0] !== VERSION)
      throw Object.assign(new Error('store: unknown file version'), {
        code: 'StoreCorrupt',
      })
    const plain = await crypto.subtle
      .decrypt({ name: 'AES-GCM', iv: file.slice(1, 13), additionalData: this.aad }, this.key, file.slice(13))
      .catch(() => {
        throw Object.assign(new Error('store: the file does not decrypt (wrong wrap key?)'), {
          code: 'StoreCorrupt',
        })
      })
    this.tables = tablesFrom(deserializeValue(new Uint8Array(plain)))
  }

  private t(tables: Tables, name: string): Map<string, unknown> {
    let m = tables.get(name)
    if (!m) tables.set(name, (m = new Map()))
    return m
  }

  private view(tables: Tables): Tx {
    return {
      get: async (table, key) => {
        const v = this.t(tables, table).get(key)
        return v === undefined ? undefined : structuredClone(v as never)
      },
      put: async (table, key, value) => {
        this.t(tables, table).set(key, structuredClone(value))
      },
      delete: async (table, key) => {
        this.t(tables, table).delete(key)
      },
      list: async (table, prefix = '') =>
        [...this.t(tables, table)]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, v]) => ({ key, value: structuredClone(v as never) })),
    }
  }

  private flush(): Promise<void> {
    const snapshot = Uint8Array.from(serializeValue(tablesTo(this.tables)))
    const run = this.writing.then(async () => {
      if (!this.key) throw new Error('store: not open')
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: this.aad },
        this.key,
        snapshot,
      )
      const tmp = `${this.path}.tmp`
      const fh = await open(tmp, 'w', 0o600)
      try {
        await fh.write(new Uint8Array([VERSION]))
        await fh.write(iv)
        await fh.write(new Uint8Array(sealed))
        await fh.sync()
      } finally {
        await fh.close()
      }
      await rename(tmp, this.path)
    })
    // A failed write fails its caller, not the writes after it.
    this.writing = run.catch(() => undefined)
    return run
  }

  get<T extends keyof StoreSchema>(table: T, key: string): Promise<StoreSchema[T] | undefined> {
    return this.view(this.tables).get(table, key)
  }

  list<T extends keyof StoreSchema>(
    table: T,
    prefix?: string,
  ): Promise<{ key: string; value: StoreSchema[T] }[]> {
    return this.view(this.tables).list(table, prefix)
  }

  async put<T extends keyof StoreSchema>(table: T, key: string, value: StoreSchema[T]): Promise<void> {
    await this.view(this.tables).put(table, key, value)
    await this.flush()
  }

  async delete<T extends keyof StoreSchema>(table: T, key: string): Promise<void> {
    await this.view(this.tables).delete(table, key)
    await this.flush()
  }

  /**
   * Atomic, as the IndexedDB store: `fn` writes to an overlay over the state (reads see its own
   * writes), and the overlay applies in one step when `fn` resolves. A rejected `fn` writes nothing.
   */
  async transaction<R>(_tables: (keyof StoreSchema)[], fn: (tx: Tx) => Promise<R>): Promise<R> {
    const overlay = new Map<string, Map<string, unknown | typeof DELETED>>()
    const o = (table: string): Map<string, unknown> => {
      let m = overlay.get(table)
      if (!m) overlay.set(table, (m = new Map()))
      return m
    }
    const live = this.view(this.tables)
    const tx: Tx = {
      get: async (table, key) => {
        const m = overlay.get(table)
        if (m?.has(key)) {
          const v = m.get(key)
          return v === DELETED ? undefined : structuredClone(v as never)
        }
        return live.get(table, key)
      },
      put: async (table, key, value) => {
        o(table).set(key, structuredClone(value))
      },
      delete: async (table, key) => {
        o(table).set(key, DELETED)
      },
      list: async (table, prefix = '') => {
        const rows = new Map((await live.list(table, prefix)).map(r => [r.key, r.value as unknown]))
        for (const [k, v] of overlay.get(table) ?? []) {
          if (!k.startsWith(prefix)) continue
          if (v === DELETED) rows.delete(k)
          else rows.set(k, structuredClone(v))
        }
        return [...rows]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => ({ key, value: value as never }))
      },
    }
    const result = await fn(tx)
    for (const [table, rows] of overlay)
      for (const [k, v] of rows) {
        if (v === DELETED) this.t(this.tables, table).delete(k)
        else this.t(this.tables, table).set(k, v)
      }
    await this.flush()
    return result
  }

  async destroy(): Promise<void> {
    this.tables = new Map()
    await this.writing
    await rm(this.path, { force: true })
  }

  close(): void {}
}
