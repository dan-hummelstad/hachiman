// Media-node voice connection. Contract: docs/gateway-protocol.md §8 and §12.10.
//
// Media is always the SDP offerer; we only answer. Track labeling (agreed with media):
// a peer's mic track has MediaStream id = the peer's userId (track id `audio-<userId>`), and its
// screen video and screen audio tracks have stream id `screen-<userId>`, so `ontrack` →
// `event.streams[0].id` names the user. The `peers` frame is the roster. The first three
// transceivers (m-lines 0 to 2) in media's initial offer are our upload slots for the mic, the
// screen and the screen audio.
//
// E2EE: this file holds no crypto. The VoiceE2eeDelegate (the @hachiman/crypto Worker in the
// shared UI) makes the key package, handles the e2ee_* ops and makes the SFrame transforms.
// This file moves the ops and installs the transforms.
import { TypedEventEmitter } from './typed-event-emitter'
import type {
  B64url,
  VoiceClientFrame,
  VoiceE2eeClientOp,
  VoiceE2eeServerOp,
  VoiceServerFrame,
} from './types'

/** `screen-audio` is the audio of a screen share (m-line 2), keyed apart from the mic (§12.10.2). */
export type VoiceTrackKind = 'audio' | 'video' | 'screen-audio'

/** The crypto side of one call (§10). Make one per call. VoiceConnection calls `close` when the call ends. */
export interface VoiceE2eeDelegate {
  /** The key package for identify. */
  start(): Promise<{ keyPackage: B64url }>
  /** One §8 e2ee_* op from media. VoiceConnection sends the result in order. */
  handle(op: VoiceE2eeServerOp): Promise<VoiceE2eeClientOp[]>
  /** Called once per call and track. The transform stays on its sender for the whole call (§12.10.2). */
  senderTransform(track: VoiceTrackKind): RTCRtpScriptTransform
  /** Called on each `ontrack`. `userId` comes from the msid. */
  receiverTransform(userId: string, track: VoiceTrackKind): RTCRtpScriptTransform
  /**
   * The receiver of a transform from `receiverTransform` ended: its track ended, its peer left, or
   * `ontrack` gave the receiver a new transform. The delegate releases the frame key port of it.
   * `close` releases the rest.
   */
  releaseTransform(transform: RTCRtpScriptTransform): void
  close(): void
}

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
   * silent until they share and `setScreenSubscriptions` names them; their voice state's
   * `selfStream` says when it is live.
   */
  screen: (e: { userId: string; stream: MediaStream | null }) => void
  /**
   * Media closed with 4013 (E2EE resync). Fires just before `close`. The owner joins again,
   * which gives a new group leaf and new sender transforms.
   */
  resync: (e: { code: number; reason: string }) => void
  /**
   * Unexpected teardown: voice WS closed without `close()` (4004 bad token, 4009 expired, 4010 kicked,
   * 4011 replaced, 4012 E2EE required, 4013 resync, 4014 E2EE violation…), renegotiation failed, or E2EE failed.
   */
  close: (e: { code: number; reason: string }) => void
}

/** Local failure codes. They never come from media. */
const LOCAL_FAILURE = 4000
const RESYNC = 4013
type SinkAudioContext = AudioContext & { setSinkId: (id: string) => Promise<void> }

/** AudioContext.setSinkId: Chromium only. */
const contextHasSink = (): boolean =>
  typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype

const SCREEN_PREFIX = 'screen-'
/** The playback key of a user's screen share audio. The mic's is the user id. Both are the stream ids (§8). */
const screenKey = (userId: string): string => SCREEN_PREFIX + userId
const ownerOf = (key: string): string => (key.startsWith(SCREEN_PREFIX) ? key.slice(SCREEN_PREFIX.length) : key)

/** True when m-line `index` of media's offer is an upload slot: media receives only (`a=recvonly`). */
function isUploadSlot(sdp: string, index: number): boolean {
  const section = sdp.split(/\r?\n(?=m=)/)[index + 1]
  return section !== undefined && /\r?\na=recvonly(\r?\n|$)/.test(section)
}

const MAX_OUTPUT_VOLUME = 2

/** The WebAudio path of one remote user above 100 %: HTMLMediaElement.volume caps at 1. */
interface Boost {
  /** A source node stays on the track it was made with, also when the stream gets a new one. */
  track: MediaStreamTrack
  source: MediaStreamAudioSourceNode
  gain: GainNode
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
  /** m-line 2. Null until the first offer, or when media offers no screen audio slot. */
  private screenAudioTransceiver: RTCRtpTransceiver | null = null
  private screenAudioTrack: MediaStreamTrack | null = null
  /** The mic Opus limit in bit/s. Null = the browser default. */
  private micBitrate: number | null = null
  /** Made once per call (§12.10.2): a new transform would start CTR at 0 again under the same key. */
  private readonly senderTransforms: Partial<Record<VoiceTrackKind, RTCRtpScriptTransform>> = {}
  /** Orders sender updates: a concurrent setParameters fails on a stale transactionId. */
  private readonly senderChains: Record<'mic' | 'screen' | 'screenAudio', Promise<void>> = {
    mic: Promise.resolve(),
    screen: Promise.resolve(),
    screenAudio: Promise.resolve(),
  }
  /** Orders e2ee ops: the delegate handles one op at a time, in arrival order. */
  private e2eeChain: Promise<void> = Promise.resolve()
  /** True after an e2ee_commit with a welcome: the next e2ee_* frame must be e2ee_ratchet_tree (§8). */
  private treeDue = false
  private readonly screens = new Map<string, MediaStream>()
  /** The users whose screen media forwards to us (§8 screen_subscribe). Sorted. */
  private screenSubs: string[] = []
  private muted = false
  private deafened = false
  private lastSpeaking: boolean | null = null
  private readonly volumes = new Map<string, number>()
  private readonly audio = new Map<string, HTMLAudioElement>()
  private readonly boosts = new Map<string, Boost>()
  /** Made on the first volume above 100 %. */
  private audioCtx: AudioContext | null = null
  /** '' = system default (the `setSinkId` convention). */
  private sinkId = ''
  private readonly pendingTracks = new Map<string, MediaStream>()
  /** The receiver transforms that this call holds, for releaseTransform. */
  private readonly recvTransforms = new Map<RTCRtpReceiver, { userId: string; transform: RTCRtpScriptTransform }>()
  private remoteCandidates: (RTCIceCandidateInit | null)[] = []
  private localCandidates: (RTCIceCandidateInit | null)[] | null = [] // null once the first answer is sent
  private offerChain: Promise<void> = Promise.resolve()
  private closed = false
  private _closeCode: number | null = null

  constructor(
    private readonly opts: {
      endpoint: string
      token: string
      iceServers: RTCIceServer[]
      /** Required: media closes 4012 without E2EE. */
      e2ee: VoiceE2eeDelegate
    },
  ) {
    super()
  }

  /** The code of an unexpected close (media close code, or 1006 'ice failed'). Null while open or after `close()`. */
  get closeCode(): number | null {
    return this._closeCode
  }

  /** Resolves on the media node's `ready` (token accepted). Audio flows once `state` reaches `connected`. */
  async connect(): Promise<void> {
    // Before the socket opens: media wants identify within 10 s of the connect.
    let keyPackage: B64url
    try {
      ;({ keyPackage } = await this.opts.e2ee.start())
    } catch (err) {
      this.close()
      throw err
    }
    if (this.closed) throw new Error('voice connect: closed')

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers })
    this.pc = pc
    pc.onconnectionstatechange = () => {
      this.emit('state', pc.connectionState)
      // A dead network can leave the socket open for minutes; ICE notices first.
      if (pc.connectionState === 'failed') this.fail(1006, 'ice failed')
    }
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
        this.send({ op: 'identify', d: { token: this.opts.token, e2ee: { version: 1, keyPackage } } })
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
    this._closeCode = code
    this.close()
    if (code === RESYNC) this.emit('resync', { code, reason })
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
    for (const userId of [...this.boosts.keys()]) this.dropBoost(userId)
    void this.audioCtx?.close().catch(() => undefined)
    this.audioCtx = null
    this.pendingTracks.clear()
    this.screens.clear()
    this.recvTransforms.clear() // e2ee.close releases them
    this.pc?.close() // does not fire connectionstatechange, so emit by hand
    this.pc = null
    try {
      this.opts.e2ee.close()
    } catch (err) {
      console.warn('VoiceConnection: e2ee close failed', err)
    }
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

  /**
   * The users whose screen share this client receives (§8 `screen_subscribe`). It replaces the
   * previous set. Media forwards no other screen, so an unwatched share costs no bandwidth. The
   * set starts empty and is sent again on `ready`, so it also holds before the connect ends.
   */
  setScreenSubscriptions(userIds: Iterable<string>): void {
    const next = [...new Set(userIds)].sort()
    if (next.length === this.screenSubs.length && next.every((u, i) => u === this.screenSubs[i])) return
    this.screenSubs = next
    if (this.sessionId !== null) this.sendScreenSubscriptions()
  }

  private sendScreenSubscriptions(): void {
    this.send({ op: 'screen_subscribe', d: { userIds: this.screenSubs } })
  }

  /**
   * The audio of the screen share (m-line 2). `null` stops sending. No renegotiation, and the
   * sender transform stays. The caller owns the track. Only the viewers that subscribe to the share
   * get it (§8).
   */
  async setScreenAudio(track: MediaStreamTrack | null): Promise<void> {
    this.screenAudioTrack = track
    await this.applyScreenAudio()
  }

  /** The local playback volume of `userId`'s screen share audio: 0..2, like `setOutputVolume`. */
  setScreenVolume(userId: string, volume: number): void {
    this.setOutputVolume(screenKey(userId), volume)
  }

  /** The send bitrate of the mic (Opus), in bit/s. `null` = the browser default. No renegotiation. */
  async setMicBitrate(maxBitrate: number | null): Promise<void> {
    this.micBitrate = maxBitrate
    await this.applyMicBitrate()
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
    for (const [userId, el] of this.audio) this.applyVolume(userId, el)
  }

  /** Route remote audio to an output device (`null` = system default). Unsupported browsers keep the default. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.sinkId = deviceId ?? ''
    await Promise.all([...this.audio.values()].map(el => this.applySink(el)))
    // Without AudioContext.setSinkId a boost can only play on the default device.
    for (const [userId, el] of this.audio) this.applyVolume(userId, el)
    await this.applyContextSink()
  }

  /** The boost path plays through the AudioContext. */
  private async applyContextSink(): Promise<void> {
    const ctx = this.audioCtx as SinkAudioContext | null
    if (!ctx || !contextHasSink()) return
    await ctx.setSinkId(this.sinkId).catch((err: unknown) => {
      console.warn('VoiceConnection: AudioContext setSinkId failed', err)
    })
  }

  private async applySink(el: HTMLAudioElement): Promise<void> {
    if (typeof el.setSinkId !== 'function' || el.sinkId === this.sinkId) return
    await el.setSinkId(this.sinkId).catch((err: unknown) => {
      console.warn('VoiceConnection: setSinkId failed', err)
    })
  }

  /** The local playback volume of one user: 0..2, 1 = unchanged. It lasts for the call, also before the track arrives. */
  setOutputVolume(userId: string, volume: number): void {
    this.volumes.set(userId, Math.min(MAX_OUTPUT_VOLUME, Math.max(0, volume)))
    const el = this.audio.get(userId)
    if (el) this.applyVolume(userId, el)
  }

  /**
   * Up to 1 the element plays the stream. Above 1 a GainNode plays it and the element stays
   * muted (it stays attached: Chromium gives a WebAudio source of a remote stream no samples
   * without one). The element plays at 1 instead while the AudioContext does not run, when
   * WebAudio fails, or when the chosen output device cannot be set on the AudioContext.
   */
  private applyVolume(userId: string, el: HTMLAudioElement): void {
    const v = this.volumes.get(userId) ?? 1
    const stream = el.srcObject as MediaStream | null
    const track = stream?.getAudioTracks()[0]
    const boost = v > 1 && stream && track ? this.boostFor(userId, stream, track) : null
    if (!boost) this.dropBoost(userId)
    const live = boost !== null && this.audioCtx?.state === 'running'
    el.volume = Math.min(1, v)
    el.muted = this.deafened || live
    if (boost) boost.gain.gain.value = this.deafened || !live ? 0 : v
  }

  private boostFor(userId: string, stream: MediaStream, track: MediaStreamTrack): Boost | null {
    const current = this.boosts.get(userId)
    if (current?.track === track) return current
    this.dropBoost(userId)
    if (typeof AudioContext === 'undefined' || (this.sinkId !== '' && !contextHasSink())) return null
    try {
      let ctx = this.audioCtx
      if (!ctx) {
        const made = new AudioContext()
        ctx = made
        this.audioCtx = made
        // Suspended, interrupted or running again: each user switches between the paths.
        made.onstatechange = () => {
          if (this.audioCtx !== made) return
          for (const [id, el] of this.audio) this.applyVolume(id, el)
        }
        void this.applyContextSink()
      }
      // A context made outside a user gesture starts suspended.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      source.connect(gain).connect(ctx.destination)
      const boost = { track, source, gain }
      this.boosts.set(userId, boost)
      return boost
    } catch (err) {
      console.warn('VoiceConnection: volume boost unavailable', err)
      return null
    }
  }

  private dropBoost(userId: string): void {
    const boost = this.boosts.get(userId)
    if (!boost) return
    this.boosts.delete(userId)
    boost.source.disconnect()
    boost.gain.disconnect()
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
        if (this.screenSubs.length > 0) this.sendScreenSubscriptions()
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
            this.fail(LOCAL_FAILURE, 'renegotiation failed')
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
        for (const [receiver, r] of this.recvTransforms) if (!present.has(r.userId)) this.releaseReceiver(receiver)
        for (const [key, el] of this.audio) {
          if (present.has(ownerOf(key))) continue
          el.pause()
          el.srcObject = null
          this.audio.delete(key)
          this.dropBoost(key)
        }
        // Tracks that arrived before their owner was in the roster.
        for (const [key, stream] of this.pendingTracks) {
          if (!present.has(ownerOf(key))) continue
          this.pendingTracks.delete(key)
          this.play(key, stream)
        }
        this.emit('peers', this.peers)
        break
      }
      case 'speaking':
        this.emit('speaking', f.d)
        break
      case 'e2ee_roster':
      case 'e2ee_key_package':
      case 'e2ee_commit_rejected':
      case 'e2ee_prepare_transition':
      case 'e2ee_welcome':
      case 'e2ee_ratchet_tree':
      case 'e2ee_execute_transition':
        this.onE2ee(f)
        break
    }
  }

  private onE2ee(op: VoiceE2eeServerOp): void {
    this.e2eeChain = this.e2eeChain
      .then(async () => {
        if (this.closed) return
        const out = await this.opts.e2ee.handle(op)
        // close() can run during the await.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.closed) return
        this.checkE2eeOrder(out)
        for (const o of out) this.send(o)
      })
      .catch((err: unknown) => {
        // Fail closed: a call with an unknown key state must not go on.
        console.warn('VoiceConnection: e2ee op failed', err)
        this.fail(LOCAL_FAILURE, 'e2ee failure')
      })
  }

  /** Throws before anything is sent when the ops break the commit → ratchet tree order of §8. */
  private checkE2eeOrder(ops: VoiceE2eeClientOp[]): void {
    let due = this.treeDue
    for (const o of ops) {
      if (due !== (o.op === 'e2ee_ratchet_tree'))
        throw new Error(`e2ee: unexpected ${o.op} (ratchet tree due: ${due})`)
      due = o.op === 'e2ee_commit' && o.d.welcome !== null
    }
    this.treeDue = due
  }

  private async answer(sdp: string): Promise<void> {
    const pc = this.pc
    if (!pc) return
    await pc.setRemoteDescription({ type: 'offer', sdp })
    // Media's first m-line is a recvonly slot reserved exclusively for our mic; peers' audio uses
    // separate sendonly transceivers. Answering sendrecv on it lets us upload.
    const [mic, screen, slot2] = pc.getTransceivers()
    // A media node without the screen audio slot has a peer track at m-line 2.
    const screenAudio = slot2 && (this.screenAudioTransceiver === slot2 || isUploadSlot(sdp, 2)) ? slot2 : undefined
    // The transforms go on before any track, so no frame leaves without SFrame. They go on in the
    // same task as setRemoteDescription, before any other await: Chromium (142, 154) binds the
    // sender's frame transformer shortly after setRemoteDescription, and a transform assigned
    // later (after addIceCandidate, or ~500 ms later) is silently ignored, so the sender sends
    // plaintext (e2e/calls found it).
    if (mic) {
      this.installSenderTransform(mic, 'audio')
      mic.direction = 'sendrecv'
      this.micTransceiver = mic
    }
    if (screen) {
      this.installSenderTransform(screen, 'video')
      screen.direction = 'sendrecv'
      this.screenTransceiver = screen
    }
    if (screenAudio) {
      this.installSenderTransform(screenAudio, 'screen-audio')
      screenAudio.direction = 'sendrecv'
      this.screenAudioTransceiver = screenAudio
    }
    for (const c of this.remoteCandidates.splice(0)) await this.addRemoteCandidate(c)
    if (mic) await this.applyMic()
    if (screenAudio) await this.applyScreenAudio()
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    // After setLocalDescription: before the first one, the sender has no encodings to limit.
    await this.applyScreen()
    await this.applyMicBitrate()
    this.send({ op: 'answer', d: { sdp: answer.sdp ?? '' } })
    const buffered = this.localCandidates
    this.localCandidates = null
    for (const c of buffered ?? []) this.send({ op: 'candidate', d: { candidate: c } })
  }

  /**
   * One transform per (call, track), never made again. The m-line 0 and 1 senders are stable across
   * renegotiations, so the assignment is a no-op after the first offer. A different sender makes
   * the browser throw (a transform belongs to one sender), and the renegotiation fails closed.
   */
  private installSenderTransform(t: RTCRtpTransceiver, track: VoiceTrackKind): void {
    let transform = this.senderTransforms[track]
    if (!transform) {
      transform = this.opts.e2ee.senderTransform(track)
      this.senderTransforms[track] = transform
    }
    if (t.sender.transform !== transform) t.sender.transform = transform
  }

  private async addRemoteCandidate(c: RTCIceCandidateInit | null): Promise<void> {
    try {
      await (c ? this.pc?.addIceCandidate(c) : this.pc?.addIceCandidate())
    } catch (err) {
      console.warn('VoiceConnection: addIceCandidate failed', err)
    }
  }

  // replaceTrack keeps sender.transform: mute, mic changes and screen start/stop reuse the transform.
  private async applyMic(): Promise<void> {
    await this.micTransceiver?.sender.replaceTrack(this.muted ? null : this.micTrack)
  }

  /** Runs `fn` after the earlier updates of the `key` sender. */
  private serial(
    key: 'mic' | 'screen' | 'screenAudio',
    fn: () => Promise<unknown> | undefined,
  ): Promise<void> {
    const next = this.senderChains[key].then(fn).then(() => undefined)
    this.senderChains[key] = next.catch(() => undefined)
    return next
  }

  private applyScreenAudio(): Promise<void> {
    return this.serial('screenAudio', () =>
      this.screenAudioTransceiver?.sender.replaceTrack(this.screenAudioTrack),
    )
  }

  private applyScreen(): Promise<void> {
    return this.serial('screen', () => this.updateScreenSender())
  }

  private applyMicBitrate(): Promise<void> {
    return this.serial('mic', () => this.updateMicSender())
  }

  private async updateMicSender(): Promise<void> {
    const sender = this.micTransceiver?.sender
    if (!sender) return
    const params = sender.getParameters()
    const enc = params.encodings[0]
    if (!enc || enc.maxBitrate === (this.micBitrate ?? undefined)) return
    if (this.micBitrate === null) delete enc.maxBitrate
    else enc.maxBitrate = this.micBitrate
    await sender.setParameters(params).catch((err: unknown) => {
      console.warn('VoiceConnection: mic setParameters failed', err)
    })
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

  /**
   * msid rule (§8): stream id `screen-<userId>` is the video track of that user, every other stream
   * id is the user id with the audio track. A track without a stream id, or whose kind does not
   * match its stream id, gets no transform and is not played: its key would bind to no user.
   */
  private onTrack(ev: RTCTrackEvent): void {
    const streamId = ev.streams[0]?.id
    if (!streamId) return
    const isScreen = streamId.startsWith(SCREEN_PREFIX)
    const userId = ownerOf(streamId)
    const kind: VoiceTrackKind = !isScreen ? 'audio' : ev.track.kind === 'audio' ? 'screen-audio' : 'video'
    if (userId === '' || ev.track.kind !== (kind === 'video' ? 'video' : 'audio')) return
    const receiver = ev.receiver
    this.releaseReceiver(receiver)
    const transform = this.opts.e2ee.receiverTransform(userId, kind)
    receiver.transform = transform
    this.recvTransforms.set(receiver, { userId, transform })
    const release = (): void => this.releaseReceiver(receiver, transform)
    if (kind === 'video') this.onScreenTrack(userId, ev, release)
    else this.onAudioTrack(streamId, ev, release)
  }

  /** Gives the receiver transform back to the delegate. With `only`, only when it is still that transform. */
  private releaseReceiver(receiver: RTCRtpReceiver, only?: RTCRtpScriptTransform): void {
    const r = this.recvTransforms.get(receiver)
    if (!r || (only !== undefined && r.transform !== only)) return
    this.recvTransforms.delete(receiver)
    try {
      this.opts.e2ee.releaseTransform(r.transform)
    } catch (err) {
      console.warn('VoiceConnection: e2ee release failed', err)
    }
  }

  /**
   * A mic (key = user id) or a screen share audio (key = `screen-<userId>`). The screen audio gets
   * a stream of its own: the msid stream also holds the screen video.
   */
  private onAudioTrack(key: string, ev: RTCTrackEvent, release: () => void): void {
    const stream = key === ownerOf(key) ? (ev.streams[0] ?? new MediaStream([ev.track])) : new MediaStream([ev.track])
    ev.track.onended = () => {
      release()
      if (this.pendingTracks.get(key) === stream) this.pendingTracks.delete(key)
      const el = this.audio.get(key)
      if (el?.srcObject !== stream) return
      el.pause()
      this.audio.delete(key)
      this.dropBoost(key)
    }
    // Only play roster members. `ontrack` fires once per transceiver, so a track that beats its
    // `peers` snapshot is parked rather than dropped.
    if (this.peers.some(p => p.userId === ownerOf(key))) this.play(key, stream)
    else this.pendingTracks.set(key, stream)
  }

  private onScreenTrack(userId: string, ev: RTCTrackEvent, release: () => void): void {
    const stream = new MediaStream([ev.track])
    ev.track.onended = () => {
      release()
      if (this.screens.get(userId) === stream) this.dropScreen(userId)
    }
    this.screens.set(userId, stream)
    this.emit('screen', { userId, stream })
  }

  private dropScreen(userId: string): void {
    this.screens.delete(userId)
    this.emit('screen', { userId, stream: null })
  }

  /** `key`: the user id for a mic, `screen-<userId>` for a screen share audio. */
  private play(key: string, stream: MediaStream): void {
    let el = this.audio.get(key)
    if (!el) {
      el = new Audio()
      el.autoplay = true
      this.audio.set(key, el)
    }
    el.srcObject = stream
    this.applyVolume(key, el)
    void this.applySink(el)
    el.play().catch((err: unknown) => {
      console.warn('VoiceConnection: autoplay blocked', err)
    })
    // The level meters show the mic only.
    if (key === ownerOf(key)) this.emit('track', { userId: key, stream })
  }

  private send(f: VoiceClientFrame): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f))
  }
}
