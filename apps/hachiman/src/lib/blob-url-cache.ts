/**
 * Object URLs of decrypted blobs (§12.9 delivery), shared by every component that shows one.
 *
 * - One load per key, however many components show it.
 * - A component acquires a URL and releases it on unmount. An entry with no holder stays for a
 *   quick remount, but at most `capacity` entries stay: the least recently used entry without a
 *   holder is revoked first.
 * - A failed load is not cached, so a remount tries again.
 * - `clear` (sign-out) revokes every URL.
 */
export interface BlobUrlCacheOptions {
  /** Most entries to keep. Entries with holders never count as evictable. */
  capacity: number
  create?: (blob: Blob) => string
  revoke?: (url: string) => void
}

interface Entry {
  promise: Promise<string>
  url: string | null
  refs: number
  used: number
}

export interface BlobUrlLease {
  url: Promise<string>
  /** Call once, on unmount. */
  release(): void
}

export class BlobUrlCache {
  private readonly entries = new Map<string, Entry>()
  private tick = 0
  private readonly create: (blob: Blob) => string
  private readonly revoke: (url: string) => void

  constructor(private readonly opts: BlobUrlCacheOptions) {
    this.create = opts.create ?? ((b) => URL.createObjectURL(b))
    this.revoke = opts.revoke ?? ((u) => URL.revokeObjectURL(u))
  }

  acquire(key: string, load: () => Promise<Blob>): BlobUrlLease {
    let entry = this.entries.get(key)
    if (!entry) {
      const e: Entry = { promise: Promise.resolve(''), url: null, refs: 0, used: 0 }
      e.promise = load().then(
        (blob) => {
          const url = this.create(blob)
          // Cleared or evicted while it loaded: nobody can release it later.
          if (this.entries.get(key) !== e) {
            this.revoke(url)
            throw new Error('the blob URL was released')
          }
          e.url = url
          return url
        },
        (err: unknown) => {
          if (this.entries.get(key) === e) this.entries.delete(key)
          throw err
        }
      )
      // The holders see the rejection; an entry that nobody holds any more must not log it.
      e.promise.catch(() => {})
      this.entries.set(key, e)
      entry = e
    }
    const held = entry
    held.refs++
    held.used = ++this.tick
    let released = false
    return {
      url: held.promise,
      release: () => {
        if (released) return
        released = true
        held.refs--
        held.used = ++this.tick
        this.evict()
      }
    }
  }

  /** Revokes every URL. Leases that are still held resolve to revoked URLs: their owners unmount. */
  clear(): void {
    for (const e of this.entries.values()) if (e.url) this.revoke(e.url)
    this.entries.clear()
  }

  /** Entries in the cache (tests). */
  get size(): number {
    return this.entries.size
  }

  private evict(): void {
    while (this.entries.size > this.opts.capacity) {
      let oldest: [string, Entry] | null = null
      for (const kv of this.entries) {
        if (kv[1].refs > 0) continue
        if (!oldest || kv[1].used < oldest[1].used) oldest = kv
      }
      if (!oldest) return
      const [key, e] = oldest
      this.entries.delete(key)
      if (e.url) this.revoke(e.url)
    }
  }
}
