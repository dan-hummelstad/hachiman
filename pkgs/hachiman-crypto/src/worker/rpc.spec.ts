import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CryptoError, type CryptoStatus, type InitOptions } from '../api'
import { LOCK_HELD_MESSAGE } from '../bridge/index'
import { inProcessClient, LocksShim, wrapKey } from '../bridge/test-harness'
import { createCryptoStore } from '../store/index'
import { FakeDs } from '../identity/test-helpers'
import { createRpcPeer, CRYPTO_API_METHODS, DS_TRANSPORT_METHODS, toErrorShape, type RpcPeer } from './rpc'

function isCode(code: string, dsCode?: string) {
  return (e: unknown) => e instanceof CryptoError && e.code === code && (dsCode === undefined || e.dsCode === dsCode)
}

describe('rpc peer', () => {
  let a: RpcPeer
  let b: RpcPeer
  let ports: MessagePort[]
  const events: { event: string; payload: unknown }[] = []

  beforeEach(() => {
    const { port1, port2 } = new MessageChannel()
    ports = [port1, port2]
    a = createRpcPeer(port1, {
      serve: () => ({
        add: (x: number, y: number) => x + y,
        fail: () => {
          throw new CryptoError('TooLarge', 'too big', 'EnvelopeTooLarge')
        },
        boom: () => {
          throw new TypeError('bug')
        },
        transport: () => Promise.reject(Object.assign(new Error('409'), { code: 'Transport', dsCode: 'EpochConflict' })),
        blob: async (b: Blob) => new Blob([await b.text(), '!'], { type: 'text/plain' }),
        port: (p: MessagePort) => {
          p.postMessage('hello over the transferred port')
        },
        hidden: () => 'never served',
        slow: () => new Promise(() => undefined),
      }),
      allow: ['add', 'fail', 'boom', 'transport', 'blob', 'port', 'slow'],
      fallbackCode: 'Internal',
    })
    b = createRpcPeer(port2, { serve: () => null, allow: [], fallbackCode: 'Transport', onEvent: (event, payload) => events.push({ event, payload }) })
  })

  afterEach(() => {
    a.close(new CryptoError('NotInitialized', 'end'))
    b.close(new CryptoError('NotInitialized', 'end'))
    for (const p of ports) p.close()
  })

  it('returns values and maps errors to CryptoError', async () => {
    expect(await b.call('add', [2, 3])).toBe(5)
    await expect(b.call('fail', [])).rejects.toSatisfy(isCode('TooLarge', 'EnvelopeTooLarge'))
    await expect(b.call('boom', [])).rejects.toSatisfy(isCode('Internal'))
    await expect(b.call('transport', [])).rejects.toSatisfy(isCode('Transport', 'EpochConflict'))
    await expect(b.call('hidden', [])).rejects.toSatisfy(isCode('Unsupported'))
    await expect(b.call('nope', [])).rejects.toSatisfy(isCode('Unsupported'))
    // The far side serves nothing.
    await expect(a.call('add', [1, 1])).rejects.toSatisfy(isCode('Unsupported'))
  })

  it('clones a Blob both ways and transfers a MessagePort', async () => {
    const out = (await b.call('blob', [new Blob(['ciphertext'])])) as Blob
    expect(out).toBeInstanceOf(Blob)
    expect(out.type).toBe('text/plain')
    expect(await out.text()).toBe('ciphertext!')

    const ch = new MessageChannel()
    const got = new Promise<unknown>((resolve) => {
      ch.port2.onmessage = (ev) => {
        resolve(ev.data)
      }
    })
    await b.call('port', [ch.port1])
    expect(await got).toBe('hello over the transferred port')
    ch.port2.close()
  })

  it('delivers events and rejects open calls on close', async () => {
    a.emit('status', { state: 'ready' })
    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({ event: 'status', payload: { state: 'ready' } })
    })
    const open = b.call('slow', [])
    b.close(new CryptoError('NotInitialized', 'disposed'))
    await expect(open).rejects.toSatisfy(isCode('NotInitialized'))
    await expect(b.call('add', [1, 2])).rejects.toSatisfy(isCode('NotInitialized'))
  })

  it('keeps a transport error code and gives unknown values the fallback', () => {
    expect(toErrorShape({ code: 'Transport', message: 'x', dsCode: 'UnknownGroup' }, 'Malformed')).toEqual({ code: 'Transport', message: 'x', dsCode: 'UnknownGroup' })
    expect(toErrorShape({ code: 'Weird', message: 'x', dsCode: 'RateLimited' }, 'Malformed')).toEqual({ code: 'Transport', message: 'x', dsCode: 'RateLimited' })
    expect(toErrorShape('text', 'Malformed')).toEqual({ code: 'Malformed', message: 'text' })
    // Without a CryptoErrorCode and without a dsCode: the fallback, never 'Transport'.
    expect(toErrorShape(new TypeError('bug'), 'Internal')).toEqual({ code: 'Internal', message: 'bug', dsCode: undefined })
    expect(toErrorShape({ code: 'LockHeld', message: 'x' }, 'Internal')).toEqual({ code: 'LockHeld', message: 'x', dsCode: undefined })
  })

  it('lists every CryptoApi and DsTransport method', () => {
    expect(CRYPTO_API_METHODS).toHaveLength(43)
    expect(DS_TRANSPORT_METHODS).toHaveLength(43)
  })
})

describe('bridge and Worker engine', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { locks: new LocksShim() })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves CryptoApi, the reverse DsTransport calls and the events', async () => {
    const ds = new FakeDs()
    const userId = ds.id()
    const transport = ds.transport(userId)
    const calls: string[] = []
    const counted = new Proxy(transport, {
      get(t, k: string) {
        const v = (t as unknown as Record<string, unknown>)[k]
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          calls.push(k)
          return (v as (...a: unknown[]) => unknown).apply(t, args)
        }
      },
    })
    const { client } = inProcessClient(counted)
    const statuses: CryptoStatus[] = []
    client.on('status', (s) => statuses.push(s))

    expect((await client.status()).state).toBe('needs_identity')
    await expect(client.setupFirstDevice()).rejects.toSatisfy(isCode('NotInitialized'))

    const init: InitOptions = { userId, wrapKey: await wrapKey(), platform: 'browser', clientVersion: '1.0.0', deviceName: 'Test', origin: 'https://takusen.test' }
    expect(await client.init(init)).toMatchObject({ state: 'needs_identity', hostTrust: 'server_code' })
    const { recoveryKey, status } = await client.setupFirstDevice()
    expect(recoveryKey).toMatch(/^HRK1-/)
    expect(status).toMatchObject({ state: 'ready', userId, primary: true })
    // The Worker reached Takusen only through the transport on this side.
    expect(calls).toEqual(expect.arrayContaining(['registerDevice', 'putMasterKey', 'putDeviceCertificate', 'uploadKeyPackages']))
    await vi.waitFor(() => {
      expect(statuses.at(-1)?.state).toBe('ready')
    })

    // A DS error crosses both boundaries with its REST code.
    await expect(client.renameDevice('00000000-0000-4000-8000-000000000000', 'x')).rejects.toSatisfy(isCode('Transport', 'UnknownDevice'))
    // A second init for the same user returns the state; another user is refused.
    expect((await client.init(init)).state).toBe('ready')
    await expect(client.init({ ...init, userId: ds.id() })).rejects.toSatisfy(isCode('Unsupported'))

    // Blobs go both ways through the API.
    const enc = await client.encryptAttachment({ file: new Blob(['attachment bytes']), name: 'a.txt', mime: 'text/plain', width: null, height: null, durationMs: null, blurhash: null, thumbnail: null })
    expect(enc.blob).toBeInstanceOf(Blob)
    const dec = await client.decryptAttachment({ key: enc.draft.key, sha256: enc.draft.sha256, mime: enc.draft.mime, size: enc.draft.size }, enc.blob)
    expect(await dec.text()).toBe('attachment bytes')
    expect(dec.type).toBe('text/plain')

    client.dispose()
    await expect(client.status()).rejects.toSatisfy(isCode('NotInitialized'))
  }, 60_000)

  it('refuses a second client on the same store (Web Lock), until the first is disposed', async () => {
    const ds = new FakeDs()
    const userId = ds.id()
    const init: InitOptions = { userId, wrapKey: await wrapKey(), platform: 'electron', clientVersion: '1.0.0', deviceName: 'Tab', origin: 'https://takusen.test' }
    const first = inProcessClient(ds.transport(userId)).client
    const second = inProcessClient(ds.transport(userId)).client
    await first.init(init)
    await expect(second.init(init)).rejects.toSatisfy((e: unknown) => isCode('LockHeld')(e) && (e as Error).message.startsWith(LOCK_HELD_MESSAGE))
    // Another user on the same origin has its own lock.
    const other = inProcessClient(ds.transport(ds.id())).client
    await other.init({ ...init, userId: ds.id() })
    first.dispose()
    await vi.waitFor(async () => {
      expect((await second.init(init)).state).toBe('needs_identity')
    })
    second.dispose()
    other.dispose()
  })

  it("gives a Worker exception without a CryptoErrorCode the code 'Internal'", async () => {
    const ds = new FakeDs()
    const userId = ds.id()
    const store = createCryptoStore()
    store.open = () => Promise.reject(new TypeError('store bug'))
    const { client } = inProcessClient(ds.transport(userId), { store })
    await expect(client.init({ userId, wrapKey: await wrapKey(), platform: 'electron', clientVersion: '1.0.0', deviceName: 'x', origin: 'https://takusen.test' })).rejects.toSatisfy(
      (e: unknown) => isCode('Internal')(e) && (e as Error).message === 'store bug',
    )
    client.dispose()
  })

  it('fails closed without a Web Locks API', async () => {
    vi.stubGlobal('navigator', {})
    const ds = new FakeDs()
    const userId = ds.id()
    const { client } = inProcessClient(ds.transport(userId))
    await expect(client.init({ userId, wrapKey: await wrapKey(), platform: 'electron', clientVersion: '1.0.0', deviceName: 'x', origin: 'https://takusen.test' })).rejects.toSatisfy(isCode('Unsupported'))
    client.dispose()
  })
})
