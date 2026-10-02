// Gateway WebSocket client. Contract: docs/gateway-protocol.md §6 and §12.13.
import type { TokenProvider } from './rest'
import { TypedEventEmitter } from './typed-event-emitter'
import {
  GatewayOp,
  type DeviceProof,
  type DeviceProver,
  type DocAwarenessRequest,
  type GatewayDevice,
  type GatewayEventName,
  type GatewayEvents,
  type GatewayFrame,
  type PresenceStatus,
  type VoiceStateUpdateRequest,
} from './types'

export type GatewayState = 'idle' | 'connecting' | 'ready' | 'resuming' | 'closed'

/** Discriminated `{ t, d }` for every dispatch event. */
export type GatewayDispatch = { [K in GatewayEventName]: { t: K; d: GatewayEvents[K] } }[GatewayEventName]

export type GatewayEventHandlers = { [K in GatewayEventName]: (d: GatewayEvents[K]) => void }

export type GatewayClientEvents = GatewayEventHandlers & {
  state: (state: GatewayState) => void
  dispatch: (e: GatewayDispatch) => void
  /** Socket closed (before any reconnect is scheduled). */
  close: (e: { code: number; reason: string }) => void
  /** 4012 (client unsupported) or 4013 (device unknown or revoked). The client stays closed. */
  fatal: (e: { code: number }) => void
}

const WS_OPEN = 1
const MAX_BACKOFF_MS = 30_000
// Close codes after which the server has discarded the session: resuming is pointless.
const SESSION_GONE = new Set([4004, 4007, 4009])
// Close codes after which no reconnect can succeed (§12.13).
const FATAL = new Set([4012, 4013])

export class GatewayClient extends TypedEventEmitter<GatewayClientEvents> {
  private _state: GatewayState = 'idle'
  private _sessionId: string | null = null
  private _latencyMs: number | null = null
  private ws: WebSocket | null = null
  private seq: number | null = null
  private wanted = false
  private attempts = 0
  private awaitingAck = false
  private beatSentAt = 0
  private timers: ReturnType<typeof setTimeout>[] = []
  private beatInterval: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly opts: {
      url: string
      getToken: TokenProvider
      /** Sent in IDENTIFY and RESUME. A throw counts as a failed attempt (backoff, then retry). */
      device: () => GatewayDevice
      /** Signs `deviceProof` of IDENTIFY and RESUME (§12.13). A rejection counts as a failed attempt. */
      proveDevice?: DeviceProver | undefined
    },
  ) {
    super()
  }

  get state(): GatewayState {
    return this._state
  }
  get sessionId(): string | null {
    return this._sessionId
  }
  /** HEARTBEAT → HEARTBEAT_ACK round trip of the last beat. */
  get latencyMs(): number | null {
    return this._latencyMs
  }

  connect(): void {
    if (this.wanted) return
    this.wanted = true
    this.attempts = 0
    this.open()
  }

  disconnect(): void {
    this.wanted = false
    clearTimeout(this.reconnectTimer)
    const ws = this.detach()
    // 1000 tells the server we are done: it ends the session (no resume).
    ws?.close(1000, 'client disconnect')
    this._sessionId = null
    this.seq = null
    this.setState('closed')
  }

  updatePresence(status: PresenceStatus): void {
    this.send(GatewayOp.PRESENCE_UPDATE, { status })
  }

  // ponytail: frames sent while not connected are dropped; add an outbox if the UI needs queueing.
  updateVoiceState(d: VoiceStateUpdateRequest): void {
    this.send(GatewayOp.VOICE_STATE_UPDATE, d)
  }

  /** Op 5: an encrypted awareness update of an open page (§6). Dropped while not connected. */
  sendDocAwareness(d: DocAwarenessRequest): void {
    this.send(GatewayOp.DOC_AWARENESS, d)
  }

  private open(): void {
    this.setState(this._sessionId ? 'resuming' : 'connecting')
    const ws = new WebSocket(this.opts.url)
    this.ws = ws
    ws.onmessage = ev => {
      if (this.ws !== ws) return
      let f: GatewayFrame
      try {
        f = JSON.parse(ev.data as string) as GatewayFrame
      } catch {
        return
      }
      this.onFrame(f)
    }
    ws.onclose = ev => {
      if (this.ws === ws) this.onClose(ev.code, ev.reason)
    }
  }

  private onFrame(f: GatewayFrame): void {
    if (typeof f.s === 'number') this.seq = f.s
    switch (f.op) {
      case GatewayOp.HELLO: {
        const interval = (f.d as { heartbeatInterval: number }).heartbeatInterval
        this.startHeartbeat(interval)
        void this.identify()
        break
      }
      case GatewayOp.HEARTBEAT_ACK:
        this.awaitingAck = false
        this._latencyMs = Date.now() - this.beatSentAt
        break
      case GatewayOp.HEARTBEAT: // server asking for an immediate beat (Discord semantics)
        this.beat()
        break
      case GatewayOp.RECONNECT:
        this.reconnect(0)
        break
      case GatewayOp.INVALID_SESSION:
        if (f.d !== true) {
          this._sessionId = null
          this.seq = null
        }
        // Discord recommends a 1–5 s random wait so a fleet of clients doesn't stampede.
        this.reconnect(1000 + Math.random() * 4000)
        break
      case GatewayOp.DISPATCH: {
        const e = { t: f.t, d: f.d } as GatewayDispatch
        if (e.t === 'READY') this._sessionId = e.d.sessionId
        if (e.t === 'READY' || e.t === 'RESUMED') {
          this.attempts = 0
          this.setState('ready')
        }
        this.emit('dispatch', e)
        ;(this.emit as (t: string, d: unknown) => boolean)(e.t, e.d)
        break
      }
    }
  }

  private async identify(): Promise<void> {
    const ws = this.ws
    let token: string
    let device: GatewayDevice
    let deviceProof: DeviceProof | undefined
    const sessionId = this._sessionId
    try {
      token = await this.opts.getToken() // fresh every time: the gateway only checks it here
      device = this.opts.device()
      if (this.opts.proveDevice) {
        const tokenSha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
        deviceProof = await this.opts.proveDevice({ kind: 'identify', sessionId, tokenSha256 })
      }
    } catch {
      if (this.ws === ws) this.reconnect()
      return
    }
    if (this.ws !== ws) return
    const { deviceId, capabilities, clientVersion } = device
    if (sessionId)
      this.send(GatewayOp.RESUME, { token, sessionId, seq: this.seq ?? 0, deviceId, deviceProof })
    else this.send(GatewayOp.IDENTIFY, { token, deviceId, capabilities, clientVersion, deviceProof })
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat()
    this.awaitingAck = false
    // Jittered first beat spreads a mass reconnect across the interval.
    this.timers.push(
      setTimeout(() => {
        this.beat()
        this.beatInterval = setInterval(() => {
          this.beat()
        }, interval)
      }, interval * Math.random()),
    )
  }

  private beat(): void {
    // No ACK since the previous beat ⇒ zombie connection: drop it and resume elsewhere.
    if (this.awaitingAck) {
      this.reconnect()
      return
    }
    this.awaitingAck = true
    this.beatSentAt = Date.now()
    this.send(GatewayOp.HEARTBEAT, this.seq)
  }

  private stopHeartbeat(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    clearInterval(this.beatInterval)
  }

  private onClose(code: number, reason: string): void {
    this.detach()
    this.emit('close', { code, reason })
    if (FATAL.has(code)) {
      this.wanted = false
      clearTimeout(this.reconnectTimer)
      this._sessionId = null
      this.seq = null
      this.setState('closed')
      this.emit('fatal', { code })
      return
    }
    if (SESSION_GONE.has(code)) {
      this._sessionId = null
      this.seq = null
    }
    if (this.wanted) this.scheduleReconnect()
    else this.setState('closed')
  }

  /** Drop the current socket (keeping the session for RESUME) and reconnect. */
  private reconnect(delayMs?: number): void {
    // Non-1000 close keeps the session resumable server-side.
    this.detach()?.close(4000, 'reconnect')
    if (this.wanted) this.scheduleReconnect(delayMs)
  }

  private scheduleReconnect(delayMs?: number): void {
    clearTimeout(this.reconnectTimer)
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts++)
    const delay = delayMs ?? backoff * (0.5 + Math.random() / 2)
    this.setState(this._sessionId ? 'resuming' : 'connecting')
    this.reconnectTimer = setTimeout(() => {
      if (this.wanted && !this.ws) this.open()
    }, delay)
  }

  private detach(): WebSocket | null {
    const ws = this.ws
    this.ws = null
    this.stopHeartbeat()
    if (ws) ws.onmessage = ws.onclose = null
    return ws
  }

  private send(op: GatewayOp, d: unknown): void {
    if (this.ws?.readyState === WS_OPEN) this.ws.send(JSON.stringify({ op, d }))
  }

  private setState(s: GatewayState): void {
    if (s === this._state) return
    this._state = s
    this.emit('state', s)
  }
}
