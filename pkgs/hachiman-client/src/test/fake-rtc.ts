// Hand-rolled WebRTC and VoiceE2eeDelegate fakes for the node test env (no jsdom, no WebRTC).
import type { VoiceE2eeDelegate, VoiceTrackKind } from '../voice'
import type { VoiceE2eeClientOp, VoiceE2eeServerOp } from '../types'

export class FakeTransform {
  constructor(
    readonly role: 'send' | 'recv',
    readonly track: VoiceTrackKind,
    readonly userId: string | null,
  ) {}
}

export interface FakeDelegate extends VoiceE2eeDelegate {
  handled: VoiceE2eeServerOp[]
  sendTransforms: FakeTransform[]
  recvTransforms: FakeTransform[]
  closeCount: number
  /** The reply of `handle`. Replace it per test. */
  respond: (op: VoiceE2eeServerOp) => Promise<VoiceE2eeClientOp[]>
}

export function fakeDelegate(): FakeDelegate {
  const d: FakeDelegate = {
    handled: [],
    sendTransforms: [],
    recvTransforms: [],
    closeCount: 0,
    respond: () => Promise.resolve([]),
    start: () => Promise.resolve({ keyPackage: 'KP' }),
    handle: op => {
      d.handled.push(op)
      return d.respond(op)
    },
    senderTransform: track => {
      const t = new FakeTransform('send', track, null)
      d.sendTransforms.push(t)
      return t
    },
    receiverTransform: (userId, track) => {
      const t = new FakeTransform('recv', track, userId)
      d.recvTransforms.push(t)
      return t
    },
    close: () => {
      d.closeCount++
    },
  }
  return d
}

/** A transform belongs to one sender, as in the browsers (InvalidStateError on reuse). */
const transformOwner = new Map<unknown, FakeSender>()

export class FakeSender {
  track: unknown = null
  private _transform: unknown = null
  readonly replaced: unknown[] = []
  get transform(): unknown {
    return this._transform
  }
  set transform(t: unknown) {
    const owner = transformOwner.get(t)
    if (owner && owner !== this) throw new DOMException('transform in use', 'InvalidStateError')
    transformOwner.set(t, this)
    this._transform = t
  }
  replaceTrack(t: unknown): Promise<void> {
    this.track = t
    this.replaced.push(t)
    return Promise.resolve()
  }
  getParameters(): { encodings: Record<string, unknown>[] } {
    return { encodings: [{}] }
  }
  setParameters(): Promise<void> {
    return Promise.resolve()
  }
}

export class FakeReceiver {
  transform: unknown = null
}

export class FakeTransceiver {
  direction = 'recvonly'
  readonly sender = new FakeSender()
  readonly receiver = new FakeReceiver()
}

export class FakeTrack {
  onended: (() => void) | null = null
  constructor(
    readonly kind: 'audio' | 'video',
    readonly id = `${kind}-track`,
  ) {}
}

export class FakeMediaStream {
  private static n = 0
  readonly id: string
  constructor(
    private readonly tracks: FakeTrack[] = [],
    id?: string,
  ) {
    this.id = id ?? `stream-${++FakeMediaStream.n}`
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter(t => t.kind === 'audio')
  }
}

export class FakeAudio {
  autoplay = false
  srcObject: unknown = null
  muted = false
  volume = 1
  paused = true
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
}

export class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = []
  static get last(): FakeRTCPeerConnection {
    const pc = FakeRTCPeerConnection.instances.at(-1)
    if (!pc) throw new Error('no peer connection')
    return pc
  }
  connectionState = 'new'
  remoteDescription: unknown = null
  closed = false
  ontrack: ((ev: unknown) => void) | null = null
  onicecandidate: ((ev: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  /** m-line 0 (mic) and 1 (screen): stable across renegotiations, as media keeps them. */
  readonly transceivers = [new FakeTransceiver(), new FakeTransceiver()]

  constructor() {
    FakeRTCPeerConnection.instances.push(this)
  }
  setRemoteDescription(d: unknown): Promise<void> {
    this.remoteDescription = d
    return Promise.resolve()
  }
  getTransceivers(): FakeTransceiver[] {
    return this.transceivers
  }
  createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' })
  }
  setLocalDescription(): Promise<void> {
    return Promise.resolve()
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve()
  }
  getStats(): Promise<Map<string, unknown>> {
    const stats = new Map<string, unknown>()
    return Promise.resolve(stats)
  }
  close(): void {
    this.closed = true
  }
  /** A remote track arrives. `streamId` null = a track without msid. */
  fireTrack(streamId: string | null, kind: 'audio' | 'video'): { receiver: FakeReceiver; track: FakeTrack } {
    const track = new FakeTrack(kind)
    const receiver = new FakeReceiver()
    const streams = streamId === null ? [] : [new FakeMediaStream([track], streamId)]
    this.ontrack?.({ track, streams, receiver })
    return { receiver, track }
  }
}

export function installFakeRtc(): void {
  FakeRTCPeerConnection.instances = []
  transformOwner.clear()
  const g = globalThis as Record<string, unknown>
  g['RTCPeerConnection'] = FakeRTCPeerConnection
  g['MediaStream'] = FakeMediaStream
  g['Audio'] = FakeAudio
}
