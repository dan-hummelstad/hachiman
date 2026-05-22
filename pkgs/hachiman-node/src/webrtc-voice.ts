import { Subject, Subscription } from 'rxjs'
import { MumbleSocket } from './mumble-socket'
import { filterPacket } from './rxjs-operators/filter-packet'
import { IceCandidate, TalkingState, WebRTC } from './mumbleproto'

export interface RemoteAudioEvent {
  session: number
  stream: MediaStream
}

export interface TalkingStateEvent {
  session: number
  target: number
}

/**
 * Manages a browser-side WebRTC PeerConnection for voice transport.
 * Handles SDP exchange via the Mumble control channel (WebRTC/IceCandidate
 * protobuf messages), microphone capture, and remote audio playback.
 */
export class WebRTCVoice {
  private pc: RTCPeerConnection
  private localStream?: MediaStream
  private ssrcToSession = new Map<number, number>()
  private audioElements = new Map<string, HTMLAudioElement>()
  private subscriptions: Subscription[] = []
  private answerSent = false
  private pendingCandidates: RTCIceCandidate[] = []

  /** Resolves when the initial SDP offer/answer exchange has completed. */
  private _offerProcessed!: () => void
  readonly offerReady = new Promise<void>((resolve) => {
    this._offerProcessed = resolve
  })

  private readonly _remoteAudio = new Subject<RemoteAudioEvent>()
  private readonly _talkingState = new Subject<TalkingStateEvent>()
  private readonly _connectionState = new Subject<RTCPeerConnectionState>()

  /** Emits when a remote user's audio stream becomes available. */
  readonly remoteAudio = this._remoteAudio.asObservable()

  /** Emits when a user's talking state changes (from TalkingState messages). */
  readonly talkingState = this._talkingState.asObservable()

  /** Emits when the PeerConnection state changes (new, connecting, connected, etc.). */
  readonly connectionState = this._connectionState.asObservable()

  constructor(
    private readonly socket: MumbleSocket,
    private readonly session: number,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    this.pc.onconnectionstatechange = () => {
      this._connectionState.next(this.pc.connectionState)
    }

    // Handle incoming remote tracks (audio from other users)
    this.pc.ontrack = (event: RTCTrackEvent) => {
      this.handleRemoteTrack(event)
    }

    // Send local ICE candidates to the server (buffered until answer is sent)
    this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return
      if (this.answerSent) {
        this.sendIceCandidate(event.candidate)
      } else {
        this.pendingCandidates.push(event.candidate)
      }
    }

    // Listen for server's ICE candidates
    const iceSub = this.socket.packet
      .pipe(filterPacket(IceCandidate))
      .subscribe(async (msg) => {
        try {
          const candidate = JSON.parse(msg.content)
          await this.pc.addIceCandidate(candidate)
        } catch (err) {
          console.warn('WebRTCVoice: failed to add ICE candidate', err)
        }
      })
    this.subscriptions.push(iceSub)

    // Listen for TalkingState messages from the server
    const tsSub = this.socket.packet
      .pipe(filterPacket(TalkingState))
      .subscribe((msg) => {
        this._talkingState.next({
          session: msg.session ?? 0,
          target: msg.target ?? 0,
        })
      })
    this.subscriptions.push(tsSub)
  }

  /** Register a user's SSRC mapping (called when UserState with ssrc is received). */
  registerSSRC(session: number, ssrc: number): void {
    this.ssrcToSession.set(ssrc, session)
  }

  /** Handle the server's SDP offer and send back our answer. */
  async handleServerOffer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp })

    // Set all recvonly transceivers to sendrecv before creating the answer
    // so the SDP answer advertises that we will send audio too.
    for (const t of this.pc.getTransceivers()) {
      if (t.direction === 'recvonly') {
        t.direction = 'sendrecv'
      }
    }

    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    await this.socket.send(
      WebRTC,
      WebRTC.create({
        sdp: answer.sdp ?? '',
        sdpType: 'answer',
      }),
    )

    // Flush any ICE candidates that were buffered while waiting for the answer
    this.answerSent = true
    for (const candidate of this.pendingCandidates) {
      this.sendIceCandidate(candidate)
    }
    this.pendingCandidates = []

    this._offerProcessed()
  }

  /** Handle the server's SDP answer (after we sent a renegotiation offer). */
  async handleServerAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  /** Start capturing and sending microphone audio. */
  async startMicrophone(): Promise<void> {
    await this.offerReady

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 48000,
      },
      video: false,
    })

    const micTrack = this.localStream.getAudioTracks()[0]
    if (!micTrack) return

    // Find a transceiver to attach the mic — either one with no sender track
    // or one that's currently only receiving.
    const transceiver = this.pc.getTransceivers().find(
      (t) => t.sender.track === null || t.currentDirection === 'recvonly',
    )
    if (transceiver) {
      transceiver.direction = 'sendrecv'
      await transceiver.sender.replaceTrack(micTrack)
    }
  }

  /** Stop sending microphone audio. */
  stopMicrophone(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop())
      delete this.localStream
    }
  }

  /** Send a talking state change to the server. */
  async sendTalkingState(target: number): Promise<void> {
    await this.socket.send(
      TalkingState,
      TalkingState.create({
        session: this.session,
        target,
      }),
    )
  }

  /** Clean up all resources. */
  close(): void {
    this.stopMicrophone()

    for (const audio of this.audioElements.values()) {
      audio.pause()
      audio.srcObject = null
    }
    this.audioElements.clear()

    for (const sub of this.subscriptions) {
      sub.unsubscribe()
    }
    this.subscriptions = []

    this.pc.close()
    this._remoteAudio.complete()
    this._talkingState.complete()
    this._connectionState.complete()
  }

  private sendIceCandidate(candidate: RTCIceCandidate): void {
    this.socket.send(
      IceCandidate,
      IceCandidate.create({
        content: JSON.stringify(candidate.toJSON()),
      }),
    )
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    const stream = event.streams[0]
    if (!stream) return

    const audio = new Audio()
    audio.srcObject = stream
    audio.autoplay = true
    this.audioElements.set(stream.id, audio)
    audio.play().catch((err) => {
      console.warn('WebRTCVoice: autoplay blocked', err)
    })

    this._remoteAudio.next({
      session: 0,
      stream,
    })

    event.track.onended = () => {
      const el = this.audioElements.get(stream.id)
      if (el) {
        el.pause()
        el.srcObject = null
        this.audioElements.delete(stream.id)
      }
    }
  }
}
