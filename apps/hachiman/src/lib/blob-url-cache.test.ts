import { describe, expect, it } from 'vitest'
import { BlobUrlCache } from './blob-url-cache'

function cache(capacity: number): { c: BlobUrlCache; live: Set<string>; revoked: string[] } {
  let n = 0
  const live = new Set<string>()
  const revoked: string[] = []
  const c = new BlobUrlCache({
    capacity,
    create: () => {
      const url = `blob:${++n}`
      live.add(url)
      return url
    },
    revoke: (url) => {
      live.delete(url)
      revoked.push(url)
    }
  })
  return { c, live, revoked }
}

const blob = (): Promise<Blob> => Promise.resolve(new Blob(['x']))

describe('BlobUrlCache', () => {
  it('loads a key once for every holder', async () => {
    const { c } = cache(4)
    let loads = 0
    const load = (): Promise<Blob> => {
      loads++
      return blob()
    }
    const a = c.acquire('k', load)
    const b = c.acquire('k', load)
    expect(await a.url).toBe(await b.url)
    expect(loads).toBe(1)
  })

  it('keeps released URLs up to the capacity, then revokes the least recently used', async () => {
    const { c, live, revoked } = cache(2)
    const leases = ['a', 'b', 'c'].map((k) => c.acquire(k, blob))
    const urls = await Promise.all(leases.map((l) => l.url))
    expect(live.size).toBe(3) // held entries never go

    leases[0]!.release()
    expect(revoked).toEqual([urls[0]])
    leases[1]!.release()
    expect(c.size).toBe(2)
    expect(live.has(urls[1]!)).toBe(true)

    // A remount of a kept entry gets the same URL without a load.
    const again = c.acquire('b', () => Promise.reject(new Error('no second load')))
    expect(await again.url).toBe(urls[1])
  })

  it('revokes every URL on clear', async () => {
    const { c, live } = cache(8)
    await c.acquire('a', blob).url
    await c.acquire('b', blob).url
    c.clear()
    expect(live.size).toBe(0)
    expect(c.size).toBe(0)
  })

  it('does not cache a failed load', async () => {
    const { c } = cache(4)
    const failed = c.acquire('k', () => Promise.reject(new Error('Malformed')))
    await expect(failed.url).rejects.toThrow('Malformed')
    expect(c.size).toBe(0)
    expect(await c.acquire('k', blob).url).toBe('blob:1')
  })

  it('revokes a URL whose entry went away while it loaded', async () => {
    const { c, live } = cache(4)
    let finish!: (b: Blob) => void
    const lease = c.acquire('k', () => new Promise<Blob>((r) => (finish = r)))
    c.clear()
    finish(new Blob(['x']))
    await expect(lease.url).rejects.toThrow('released')
    expect(live.size).toBe(0)
  })

  it('ignores a second release', async () => {
    const { c, live } = cache(0)
    const a = c.acquire('k', blob)
    const b = c.acquire('k', blob)
    await a.url
    a.release()
    a.release()
    expect(live.size).toBe(1) // b still holds it
    b.release()
    expect(live.size).toBe(0)
  })
})
