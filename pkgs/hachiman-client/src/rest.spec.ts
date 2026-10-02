import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestClient, RestError } from './rest'

// Hand-rolled XMLHttpRequest fake for the node test env (no jsdom).
class FakeXHR {
  static last: FakeXHR | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = undefined
  status = 0
  responseText = ''
  aborted = false
  upload: {
    onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null
  } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXHR.last = this
  }
  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v
  }
  send(body: unknown): void {
    this.body = body
  }
  abort(): void {
    this.aborted = true
    this.onabort?.()
  }
  respond(status: number, body: string): void {
    this.status = status
    this.responseText = body
    this.onload?.()
  }
}

const sent = async (): Promise<FakeXHR> => {
  await vi.waitFor(() => {
    expect(FakeXHR.last?.body).toBeDefined()
  })
  return FakeXHR.last!
}

describe('RestClient files', () => {
  const rest = new RestClient({ baseUrl: 'http://api/v1/', getToken: () => Promise.resolve('tok') })

  beforeEach(() => {
    FakeXHR.last = null
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fileUrl encodes each path segment', () => {
    expect(rest.fileUrl('abc/my file#1?.png')).toBe('http://api/v1/files/abc/my%20file%231%3F.png')
  })

  it('upload sends the raw file with auth, type and query, reports progress, resolves the Attachment', async () => {
    const onProgress = vi.fn()
    const file = new Blob(['hello'], { type: 'image/png' })
    const p = rest.upload(file, { filename: 'a b.png', width: 10, height: 20, onProgress })
    const xhr = await sent()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('http://api/v1/uploads?filename=a+b.png&width=10&height=20')
    expect(xhr.headers['Authorization']).toBe('Bearer tok')
    expect(xhr.headers['Content-Type']).toBe('image/png')
    expect(xhr.body).toBe(file)
    xhr.upload.onprogress?.({ loaded: 2, total: 5, lengthComputable: true })
    xhr.upload.onprogress?.({ loaded: 3, total: 0, lengthComputable: false })
    expect(onProgress.mock.calls).toEqual([
      [2, 5],
      [3, 5],
    ])
    const att = {
      id: 'u',
      key: 'u/a_b.png',
      filename: 'a b.png',
      size: 5,
      contentType: 'image/png',
      width: 10,
      height: 20,
    }
    xhr.respond(201, JSON.stringify(att))
    await expect(p).resolves.toEqual(att)
  })

  it('upload defaults Content-Type to application/octet-stream', async () => {
    void rest.upload(new Blob(['x']), { filename: 'x' }).catch(() => undefined)
    expect((await sent()).headers['Content-Type']).toBe('application/octet-stream')
  })

  it('upload maps a 413 to RestError like the fetch path', async () => {
    const p = rest.upload(new Blob(['x']), { filename: 'x' })
    ;(await sent()).respond(413, JSON.stringify({ error: 'UploadTooLarge', message: 'too big' }))
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RestError)
    expect(err).toMatchObject({ status: 413, code: 'UploadTooLarge', message: 'too big' })
  })

  it('upload maps a non-JSON error body to HTTP_<status>', async () => {
    const p = rest.upload(new Blob(['x']), { filename: 'x' })
    ;(await sent()).respond(413, '<html>nginx</html>')
    await expect(p).rejects.toMatchObject({ status: 413, code: 'HTTP_413' })
  })

  it('aborting the signal aborts the XHR and rejects with AbortError', async () => {
    const ac = new AbortController()
    const p = rest.upload(new Blob(['x']), { filename: 'x', signal: ac.signal })
    const xhr = await sent()
    ac.abort()
    expect(xhr.aborted).toBe(true)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('an already-aborted signal rejects without opening a request', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(rest.upload(new Blob(['x']), { filename: 'x', signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(FakeXHR.last).toBeNull()
  })
})
