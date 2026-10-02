// Media-node voice connection. Contract: docs/gateway-protocol.md §8.
//
// Media is always the SDP offerer; we only answer. Track labeling (agreed with media):
// a peer's mic track has MediaStream id = the peer's userId (track id `audio-<userId>`), and its
// screen track has stream id `screen-<userId>`, so `ontrack` → `event.streams[0].id` names the user.
// The `peers` frame is the roster. The first two transceivers (m-lines 0 and 1) in media's initial
// offer are our upload slots for the mic and the screen.
import { TypedEventEmitter } from './typed-event-emitter'
import type { VoiceClientFrame, VoiceServerFrame } from './types'

export interface VoicePeer {
  userId: string
  ssrc: number
}

/** Sender limits for the screen share (`RTCRtpEncodingParameters`). */
export interface ScreenEncoding {
  maxBitrate: number
  maxFramerate: number
}

export interface VoiceStats {
  rttMs: number | null
  jitterMs: number | null
  /** Cumulative inbound loss fraction 0..1. */
  packetLoss: number | null
}

// A type alias (not an interface) so it satisfies EventsMap's index signature.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type VoiceEvents = {
  state: (state: RTCPeerConnectionState) => void
  speaking: (e: { userId: string; speaking: boolean }) => void
  peers: (peers: VoicePeer[]) => void
  /** A remote user's audio stream arrived (e.g. for level meters). */
  track: (e: { userId: string; stream: MediaStream }) => void
  /**
   * A remote user's screen track arrived (`null` = gone). The track exists for every peer and is
   * silent until they share; their voice state's `selfStream` says when it is live.
   */
  screen: (e: { userId: string; stream: MediaStream | null }) => void
  /** Unexpected teardown: voice WS closed without `close()` (4004 bad token, 4009 expired, 4010 kicked, 4011 replaced…) or renegotiation failed. */
  close: (e: { code: number; reason: string }) => void
}

export class VoiceConnection extends TypedEventEmitter<VoiceEvents> {
  /** Media session id + our SSRC, from the `ready` frame. */
  sessionId: string | null = null
  ssrc: number | null = null
  peers: VoicePeer[] = []

  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private micTransceiver: RTCRtpTransceiver | null = null
  private micTrack: MediaStreamTrack | null = null
  private screenTransceiver: RTCRtpTransceiver | null = null
  private screenTrack: MediaStreamTrack | null = null
  private screenEncoding: ScreenEncoding | null = null
  /** Orders sender updates: a concurrent setParameters fails on a stale transactionId. */
  private screenChain: Promise<void> = Promise.resolve()
  private readonly screens = new Map<string, MediaStream>()
  private muted = false
  private deafened = false
  private lastSpeaking: boolean | null = null
  private readonly volumes = new Map<string, number>()
  private readonly audio = new Map<string, HTMLAudioElement>()
  /** '' = system default (the `setSinkId` convention). */
  private sinkId = ''
  private readonly pendingTracks = new Map<string, MediaStream>()
  private remoteCandidates: (RTCIceCandidateInit | null)[] = []
  private localCandidates: (RTCIceCandidateInit | null)[] | null = [] // null once the first answer is sent
  private offerChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly opts: { endpoint: string; token: string; iceServers: RTCIceServer[] }) {
    super()
  }

  /** Resolves on the media node's `ready` (token accepted). Audio flows once `state` reaches `connected`. */
  connect(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers })
    this.pc = pc
    pc.onconnectionstatechange = () => this.emit('state', pc.connectionState)
    pc.onicecandidate = ev => {
      const c = ev.candidate?.toJSON() ?? null
      // Media expects candidates after our answer; buffer anything gathered before it's sent.
      if (this.localCandidates) this.localCandidates.push(c)
      else this.send({ op: 'candidate', d: { candidate: c } })
    }
    pc.ontrack = ev => {
      this.onTrack(ev)
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.endpoint)
      this.ws = ws
      let settled = false
      ws.onopen = () => {
        this.send({ op: 'identify', d: { token: this.opts.token } })
      }
      ws.onmessage = ev => {
        const f = JSON.parse(ev.data as string) as VoiceServerFrame
        if (f.op === 'ready' && !settled) {
          settled = true
          resolve()
        }
        this.onFrame(f)
      }
      ws.onclose = ev => {
        if (!settled) reject(new Error(`voice connect failed: ${ev.code} ${ev.reason}`))
        settled = true
        this.fail(ev.code, ev.reason)
      }
    })
  }

  /** Unexpected teardown: close and tell the owner (unlike `close()`, which is owner-initiated). */
  private fail(code: number, reason: string): void {
    if (this.closed) return
    this.close()
    this.emit('close', { code, reason })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState <= 1) ws.close(1000)
    for (const el of this.audio.values()) {
      el.pause()
      el.srcObject = null
    }
    this.audio.clear()
    this.pendingTracks.clear()
    this.screens.clear()
    this.pc?.close() // does not fire connectionstatechange, so emit by hand
    this.pc = null
    this.emit('state', 'closed')
  }

  /** `null` stops sending. The caller owns the stream (we never stop its tracks). */
  async setMicrophone(stream: MediaStream | null): Promise<void> {
    this.micTrack = stream?.getAudioTracks()[0] ?? null
    await this.applyMic()
  }

  /** `null` stops sending. The caller owns the track (we never stop it). */
  async setScreen(track: MediaStreamTrack | null, encoding: ScreenEncoding | null = null): Promise<void> {
    this.screenTrack = track
    this.screenEncoding = encoding
    await this.applyScreen()
  }

  /** Self-mute: stop sending without releasing the mic stream. */
  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    if (muted) this.setSpeaking(false)
    await this.applyMic()
  }

  setSpeaking(speaking: boolean): void {
    if (speaking && this.muted) return
    if (speaking === this.lastSpeaking) return
    this.lastSpeaking = speaking
    this.send({ op: 'speaking', d: { speaking } })
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const el of this.audio.values()) el.muted = deafened
  }

  /** Route remote audio to an output device (`null` = system default). Unsupported browsers keep the default. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.sinkId = deviceId ?? ''
    await Promise.all([...this.audio.values()].map(el => this.applySink(el)))
  }

  private async applySink(el: HTMLAudioElement): Promise<void> {
    if (typeof el.setSinkId !== 'function' || el.sinkId === this.sinkId) return
    await el.setSinkId(this.sinkId).catch((err: unknown) => {
      console.warn('VoiceConnection: setSinkId failed', err)
    })
  }

  // ponytail: HTMLAudioElement caps at 1.0; >100% boost needs a WebAudio GainNode per user.
  setOutputVolume(userId: string, volume: number): void {
    const v = Math.min(1, Math.max(0, volume))
    this.volumes.set(userId, v)
    const el = this.audio.get(userId)
    if (el) el.volume = v
  }

  async getStats(): Promise<VoiceStats> {
    const out: VoiceStats = { rttMs: null, jitterMs: null, packetLoss: null }
    if (!this.pc) return out
    let lost = 0
    let received = 0
    let pairRtt: number | null = null
    const report = await this.pc.getStats().catch(() => null)
    report?.forEach((raw: unknown) => {
      const s = raw as {
        type?: string
        kind?: string
        packetsLost?: number
        packetsReceived?: number
        jitter?: number
        roundTripTime?: number
        currentRoundTripTime?: number
        nominated?: boolean
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        lost += s.packetsLost ?? 0
        received += s.packetsReceived ?? 0
        if (typeof s.jitter === 'number') out.jitterMs = Math.max(out.jitterMs ?? 0, s.jitter * 1000)
      } else if (s.type === 'remote-inbound-rtp' && typeof s.roundTripTime === 'number') {
        out.rttMs = s.roundTripTime * 1000
      } else if (s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') {
        pairRtt = s.currentRoundTripTime * 1000
      }
    })
    // RTCP-based RTT needs a few seconds of sending; the ICE pair RTT is available immediately.
    out.rttMs ??= pairRtt
    if (lost + received > 0) out.packetLoss = lost / (lost + received)
    return out
  }

  private onFrame(f: VoiceServerFrame): void {
    switch (f.op) {
      case 'ready':
        this.sessionId = f.d.sessionId
        this.ssrc = f.d.ssrc
        break
      case 'offer': {
        const sdp = f.d.sdp
        // Renegotiations can arrive back-to-back; handle strictly in order.
        this.offerChain = this.offerChain
          .then(() => this.answer(sdp))
          .catch((err: unknown) => {
            // A failed renegotiation leaves the PC unusable; surface it as a close so the owner
            // (HachimanClient) clears the gateway voice state and the UI can rejoin.
            console.warn('VoiceConnection: renegotiation failed', err)
            this.fail(4000, 'renegotiation failed')
          })
        break
      }
      case 'candidate':
        if (this.pc?.remoteDescription) void this.addRemoteCandidate(f.d.candidate)
        else this.remoteCandidates.push(f.d.candidate)
        break
      case 'peers': {
        this.peers = f.d.peers
        const present = new Set(this.peers.map(p => p.userId))
        for (const userId of this.screens.keys()) if (!present.has(userId)) this.dropScreen(userId)
        for (const [userId, el] of this.audio) {
          if (present.has(userId)) continue
          el.pause()
          el.srcObject = null
          this.audio.delete(userId)
        }
        // Tracks that arrived before their owner was in the roster.
        for (const [userId, stream] of this.pendingTracks) {
          if (!present.has(userId)) continue
          this.pendingTracks.delete(userId)
          this.play(userId, stream)
        }
        this.emit('peers', this.peers)
        break
      }
      case 'speaking':
        this.emit('speaking', f.d)
        break
    }
  }

  private async answer(sdp: string): Promise<void> {
    const pc = this.pc
    if (!pc) return
    await pc.setRemoteDescription({ type: 'offer', sdp })
    for (const c of this.remoteCandidates.splice(0)) await this.addRemoteCandidate(c)
    // Media's first m-line is a recvonly slot reserved exclusively for our mic; peers' audio uses
    // separate sendonly transceivers. Answering sendrecv on it lets us upload.
    const [mic, screen] = pc.getTransceivers()
    if (mic) {
      mic.direction = 'sendrecv'
      this.micTransceiver = mic
      await this.applyMic()
    }
    if (screen) {
      screen.direction = 'sendrecv'
      this.screenTransceiver = screen
    }
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    // After setLocalDescription: before the first one, the sender has no encodings to limit.
    await this.applyScreen()
    this.send({ op: 'answer', d: { sdp: answer.sdp ?? '' } })
    const buffered = this.localCandidates
    this.localCandidates = null
    for (const c of buffered ?? []) this.send({ op: 'candidate', d: { candidate: c } })
  }

  private async addRemoteCandidate(c: RTCIceCandidateInit | null): Promise<void> {
    try {
      await (c ? this.pc?.addIceCandidate(c) : this.pc?.addIceCandidate())
    } catch (err) {
      console.warn('VoiceConnection: addIceCandidate failed', err)
    }
  }

  private async applyMic(): Promise<void> {
    await this.micTransceiver?.sender.replaceTrack(this.muted ? null : this.micTrack)
  }

  private applyScreen(): Promise<void> {
    const next = this.screenChain.then(() => this.updateScreenSender())
    this.screenChain = next.catch(() => undefined)
    return next
  }

  private async updateScreenSender(): Promise<void> {
    const sender = this.screenTransceiver?.sender
    if (!sender) return
    await sender.replaceTrack(this.screenTrack)
    const params = sender.getParameters()
    const enc = params.encodings[0]
    if (!enc || !this.screenEncoding) return
    Object.assign(enc, this.screenEncoding)
    await sender.setParameters(params).catch((err: unknown) => {
      console.warn('VoiceConnection: screen setParameters failed', err)
    })
  }

  private onTrack(ev: RTCTrackEvent): void {
    if (ev.track.kind === 'video') {
      this.onScreenTrack(ev)
      return
    }
    const stream = ev.streams[0] ?? new MediaStream([ev.track])
    const userId = ev.streams[0]?.id ?? ev.track.id.replace(/^audio-/, '')
    ev.track.onended = () => {
      if (this.pendingTracks.get(userId) === stream) this.pendingTracks.delete(userId)
      const el = this.audio.get(userId)
      if (el?.srcObject !== stream) return
      el.pause()
      this.audio.delete(userId)
    }
    // Only play roster members. `ontrack` fires once per transceiver, so a track that beats its
    // `peers` snapshot is parked rather than dropped.
    if (this.peers.some(p => p.userId === userId)) this.play(userId, stream)
    else this.pendingTracks.set(userId, stream)
  }

  private onScreenTrack(ev: RTCTrackEvent): void {
    const id = ev.streams[0]?.id
    if (!id?.startsWith('screen-')) return
    const userId = id.slice('screen-'.length)
    const stream = new MediaStream([ev.track])
    ev.track.onended = () => {
      if (this.screens.get(userId) === stream) this.dropScreen(userId)
    }
    this.screens.set(userId, stream)
    this.emit('screen', { userId, stream })
  }

  private dropScreen(userId: string): void {
    this.screens.delete(userId)
    this.emit('screen', { userId, stream: null })
  }

  private play(userId: string, stream: MediaStream): void {
    let el = this.audio.get(userId)
    if (!el) {
      el = new Audio()
      el.autoplay = true
      this.audio.set(userId, el)
    }
    el.srcObject = stream
    el.muted = this.deafened
    el.volume = this.volumes.get(userId) ?? 1
    void this.applySink(el)
    el.play().catch((err: unknown) => {
      console.warn('VoiceConnection: autoplay blocked', err)
    })
    this.emit('track', { userId, stream })
  }

  private send(f: VoiceClientFrame): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f))
  }
}
