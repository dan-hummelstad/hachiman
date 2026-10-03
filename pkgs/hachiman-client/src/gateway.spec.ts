import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayClient } from './gateway'
import { FakeWebSocket, installFakeWebSocket } from './test/fake-ws'

const flush = () => vi.advanceTimersByTimeAsync(0)
const device = { deviceId: 'dev1', capabilities: ['e2ee/1'], clientVersion: '1.0.0' }
const identify = (token: string) => ({ op: 2, d: { token, ...device } })
const resume = (token: string, seq: number) => ({
  op: 6,
  d: { token, sessionId: 'S', seq, deviceId: 'dev1' },
})

describe('GatewayClient', () => {
  let tokens = 0
  let gw: GatewayClient
  beforeEach(() => {
    vi.useFakeTimers()
    installFakeWebSocket()
    tokens = 0
    gw = new GatewayClient({
      url: 'ws://gw',
      getToken: () => Promise.resolve(`tok${++tokens}`),
      device: () => device,
    })
  })
  afterEach(() => {
    gw.disconnect()
    vi.useRealTimers()
  })

  async function ready(ws: FakeWebSocket, seq = 1) {
    ws.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    ws.recv({
      op: 0,
      s: seq,
      t: 'READY',
      d: { v: 1, sessionId: 'S', user: { id: 'me' }, guilds: [], privateChannels: [], presences: [] },
    })
  }

  it('HELLO → IDENTIFY with a fresh token, READY → ready', async () => {
    const states: string[] = []
    gw.on('state', s => states.push(s))
    gw.connect()
    await ready(FakeWebSocket.last)
    expect(FakeWebSocket.last.sent[0]).toEqual(identify('tok1'))
    expect(gw.state).toBe('ready')
    expect(gw.sessionId).toBe('S')
    expect(states).toEqual(['connecting', 'ready'])
  })

  it('tracks seq, heartbeats with it and measures latency', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws)
    const typing = vi.fn()
    gw.on('TYPING_START', typing)
    ws.recv({ op: 0, s: 7, t: 'TYPING_START', d: { channelId: 'c' } })
    expect(typing).toHaveBeenCalledWith({ channelId: 'c' })
    await vi.advanceTimersByTimeAsync(1000) // first (jittered) beat lands within one interval
    expect(ws.sent.at(-1)).toEqual({ op: 1, d: 7 })
    ws.recv({ op: 11, d: null })
    expect(gw.latencyMs).not.toBeNull()
  })

  it('sendDocAwareness sends op 5; an ephemeral dispatch (no s) keeps the seq', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws, 3)
    gw.sendDocAwareness({ channelId: 'c', pageId: 'p', envelope: 'E' })
    expect(ws.sent.at(-1)).toEqual({ op: 5, d: { channelId: 'c', pageId: 'p', envelope: 'E' } })
    const aw = vi.fn()
    gw.on('DOC_AWARENESS', aw)
    ws.recv({ op: 0, t: 'DOC_AWARENESS', d: { channelId: 'c', pageId: 'p', envelope: 'E' } })
    expect(aw).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.sent.at(-1)).toEqual({ op: 1, d: 3 })
  })

  it('missed HEARTBEAT_ACK ⇒ reconnect + RESUME', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws, 3)
    await vi.advanceTimersByTimeAsync(2000) // beat, then next beat finds no ACK
    expect(ws.closedWith).toBe(4000)
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws)
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws2.sent[0]).toEqual(resume('tok2', 3))
  })

  it('IDENTIFY and RESUME carry deviceProof over the session id and SHA-256(token) (§12.13)', async () => {
    gw.disconnect()
    const seen: unknown[] = []
    gw = new GatewayClient({
      url: 'ws://gw',
      getToken: () => Promise.resolve(`tok${++tokens}`),
      device: () => device,
      proveDevice: r => {
        seen.push(r)
        return Promise.resolve({ ts: 1, nonce: 'n', sig: 's' })
      },
    })
    const sha = async (s: string) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
    gw.connect()
    const ws = FakeWebSocket.last
    ws.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0))
    expect(ws.sent[0]).toEqual({ op: 2, d: { token: 'tok1', ...device, deviceProof: { ts: 1, nonce: 'n', sig: 's' } } })
    expect(seen[0]).toEqual({ kind: 'identify', sessionId: null, tokenSha256: await sha('tok1') })
    ws.recv({
      op: 0,
      s: 1,
      t: 'READY',
      d: { v: 1, sessionId: 'S', user: { id: 'me' }, guilds: [], privateChannels: [], presences: [] },
    })
    ws.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(0))
    expect(ws2.sent[0]).toEqual({
      op: 6,
      d: { token: 'tok2', sessionId: 'S', seq: 1, deviceId: 'dev1', deviceProof: { ts: 1, nonce: 'n', sig: 's' } },
    })
    expect(seen[1]).toEqual({ kind: 'identify', sessionId: 'S', tokenSha256: await sha('tok2') })
  })

  it('close → RESUME with last seq; RESUMED → ready', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws)
    ws.recv({ op: 0, s: 42, t: 'MESSAGE_CREATE', d: {} })
    ws.drop(1006)
    expect(gw.state).toBe('resuming')
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws2.sent[0]).toEqual(resume('tok2', 42))
    ws2.recv({ op: 0, s: 43, t: 'RESUMED', d: {} })
    expect(gw.state).toBe('ready')
  })

  it('INVALID_SESSION(false) ⇒ fresh IDENTIFY on a new socket', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws)
    ws.recv({ op: 9, d: false })
    expect(gw.sessionId).toBeNull()
    await vi.advanceTimersByTimeAsync(5000)
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws)
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws2.sent[0]).toEqual(identify('tok2'))
  })

  it('RECONNECT ⇒ immediate reconnect + RESUME', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws, 5)
    ws.recv({ op: 7, d: null })
    await flush()
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws)
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws2.ops()[0]).toBe(6)
  })

  it('disconnect() closes with 1000 and does not reconnect', async () => {
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws)
    gw.disconnect()
    expect(ws.closedWith).toBe(1000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(gw.state).toBe('closed')
  })

  it.each([4012, 4013])('close %i ⇒ closed, fatal, no reconnect', async code => {
    const fatal = vi.fn()
    const closes = vi.fn()
    gw.on('fatal', fatal)
    gw.on('close', closes)
    gw.connect()
    const ws = FakeWebSocket.last
    await ready(ws)
    ws.drop(code, 'nope')
    expect(closes).toHaveBeenCalledWith({ code, reason: 'nope' })
    expect(fatal).toHaveBeenCalledWith({ code })
    expect(gw.state).toBe('closed')
    expect(gw.sessionId).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('connect() after a fatal close starts a fresh IDENTIFY', async () => {
    gw.connect()
    await ready(FakeWebSocket.last)
    FakeWebSocket.last.drop(4013)
    gw.connect()
    const ws2 = FakeWebSocket.last
    expect(FakeWebSocket.instances).toHaveLength(2)
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws2.sent[0]).toEqual(identify('tok2'))
  })

  it('a device() throw counts as a failed attempt and retries with backoff', async () => {
    let calls = 0
    const gw2 = new GatewayClient({
      url: 'ws://gw',
      getToken: () => Promise.resolve('t'),
      device: () => {
        if (++calls === 1) throw new Error('no device')
        return device
      },
    })
    gw2.connect()
    const ws = FakeWebSocket.last
    ws.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws.sent).toEqual([])
    expect(ws.closedWith).toBe(4000)
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.recv({ op: 10, d: { heartbeatInterval: 1000 } })
    await flush()
    expect(ws2.sent[0]).toEqual(identify('t'))
    gw2.disconnect()
  })
})
