import {
  Permissions,
  has,
  type Channel,
  type SelfVoice,
  type VoiceConnection
} from '@hachiman/client'
import { isGuildChannel } from '@/lib/model'
import { ResyncBackoff } from '@/lib/resync-backoff'
import { captureConstraints, tuneTrack, type StreamQuality } from '@/lib/stream-quality'
import { hachiman } from '@/services/hachiman'
import { playSound, selfVoiceSound } from '@/services/SoundService'
import { setCryptoFatal, useCryptoStore } from '@/stores/cryptoStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const STATS_MS = 2_000
const VAD_MS = 50
const VAD_THRESHOLD = 0.02 // RMS
const VAD_HANGOVER_MS = 300
/** Media close codes (§8). */
const MEDIA_UNSUPPORTED = 4012
/**
 * Drops that a rejoin can fix: the network (1006, also ICE failed) and a media node shutdown
 * (1001). Not a kick, a replace by another device or an E2EE failure: a rejoin would undo it or
 * fail again, for the whole room.
 */
const REJOIN_CODES = new Set([1001, 1006])
const REJOIN_DELAY_MS = 1_000

/** A captured microphone plus its voice-activity detector. `stop()` releases both. */
interface MicSession {
  stop(): void
}

/**
 * Runs local voice-activity detection on `stream`. `onSpeaking` fires on changes only, and with
 * `false` on stop. `live()` gates it, so a muted user never shows as speaking.
 */
function startMicSession(
  stream: MediaStream,
  live: () => boolean,
  onSpeaking: (speaking: boolean) => void
): MicSession {
  const audioCtx = new AudioContext()
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  audioCtx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  let lastLoud = 0
  let speaking = false
  const report = (next: boolean): void => {
    if (next === speaking) return
    speaking = next
    onSpeaking(next)
  }
  const vad = setInterval(() => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const now = Date.now()
    if (Math.sqrt(sum / buf.length) > VAD_THRESHOLD) lastLoud = now
    report(live() && now - lastLoud < VAD_HANGOVER_MS)
  }, VAD_MS)
  return {
    stop: () => {
      clearInterval(vad)
      void audioCtx.close()
      stopTracks(stream)
      report(false)
    }
  }
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop())
}

function captureMic(): Promise<MediaStream> {
  const deviceId = usePrefsStore.getState().inputDeviceId
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {})
    }
  })
}

function captureScreen(q: StreamQuality): Promise<MediaStream> {
  // ponytail: video only; system audio capture differs per OS and host. Add `audio: true` with a
  // second upload slot when it matters.
  return navigator.mediaDevices.getDisplayMedia({ video: captureConstraints(q), audio: false })
}

/**
 * Global single voice session over HachimanClient.joinVoice / VoiceConnection. Mute/deafen policy
 * lives in the client (`setSelfVoice`); this service mirrors the result into `useVoiceStore`.
 */
class VoiceService {
  private conn: VoiceConnection | null = null
  private mic: MicSession | null = null
  /** Bumped by every mic start/stop, so a late getUserMedia can tell it was superseded. */
  private micAttempt = 0
  private screen: MediaStream | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  /**
   * The call that dropped without the user leaving (network, media node, new gateway session). It
   * joins again once, when the gateway is ready.
   */
  private lost: { guildId: string; channelId: string } | null = null
  /** Set by media close 4013: the drop that follows rejoins this target instead of ending. */
  private resync: { guildId: string; channelId: string } | null = null
  /** Consecutive 4013 rejoins without keys, and the timer of the next one. */
  private readonly resyncBackoff = new ResyncBackoff()
  private resyncTimer: ReturnType<typeof setTimeout> | null = null

  /** Wires the client and prefs subscriptions. `startHachiman()` calls it once. */
  start(): void {
    // The persisted prefs seed the client, which owns mute/deafen state from here on.
    const { ownMute, selfDeaf } = useVoiceStore.getState()
    this.setSelfVoice({ selfMute: ownMute, selfDeaf })
    // Dropped underneath us (kicked / replaced / media drop / gateway disconnect on sign-out).
    // Our own leave/switch clears `this.conn` first, so those don't land here.
    hachiman.on('voice', (vc) => {
      if (vc) {
        vc.on('close', ({ code }) => {
          if (code === MEDIA_UNSUPPORTED) setCryptoFatal('update_required')
        })
        return
      }
      const resync = this.resync
      this.resync = null
      if (resync) return void this.rejoin(resync)
      if (!this.conn) return
      // No close code: the client dropped the call itself (a new gateway session).
      const code = this.conn.closeCode
      const { guildId, channelId } = useVoiceStore.getState()
      playSound('voiceDisconnect')
      this.endSession()
      if (!guildId || !channelId || (code !== null && !REJOIN_CODES.has(code))) return
      this.lost = { guildId, channelId }
      setTimeout(() => this.rejoinLost(), REJOIN_DELAY_MS)
    })
    hachiman.on('state', (state) => {
      if (state === 'ready') this.rejoinLost()
    })
    // Media close 4013 (§8): the E2EE state must start again. The client leaves voice next; the
    // 'voice' handler above then joins again, which gives a new leaf and new transforms.
    hachiman.on('voiceResync', (target) => {
      this.resync = target
      useCryptoStore.setState({ voiceResyncing: true })
    })
    // A call with an active epoch worked: a later 4013 is not part of the same failure.
    useCryptoStore.subscribe((s, prev) => {
      if (s.voice?.epoch != null && prev.voice?.epoch == null) this.resyncBackoff.reset()
    })
    // Device changes from user settings apply to the live session.
    usePrefsStore.subscribe((s, prev) => {
      if (s.inputDeviceId !== prev.inputDeviceId && this.conn) void this.startMic()
      if (s.outputDeviceId !== prev.outputDeviceId) this.applyOutputDevice()
      if (s.streamQuality !== prev.streamQuality) void this.applyStreamQuality()
    })
  }

  /** Join a guild voice channel if I may CONNECT there; otherwise a no-op. */
  join(channel: Channel): Promise<void> {
    if (
      channel.type !== 'voice' ||
      !isGuildChannel(channel) ||
      !has(hachiman.permissionsFor(channel.id), Permissions.CONNECT)
    )
      return Promise.resolve()
    return this.joinVoice(channel.guildId, channel.id)
  }

  /** A join by the user. It cancels a waiting automatic rejoin. */
  joinVoice(guildId: string, channelId: string): Promise<void> {
    this.cancelResync()
    this.lost = null
    return this.connect(guildId, channelId)
  }

  private async connect(guildId: string, channelId: string): Promise<void> {
    if (useVoiceStore.getState().channelId === channelId) return
    this.teardown()
    useVoiceStore.setState({ guildId, channelId, connectionState: 'new', screens: new Map() })
    try {
      const conn = await hachiman.joinVoice(guildId, channelId)
      this.conn = conn
      playSound('voiceJoin')
      this.applyOutputDevice()
      conn.on('state', (connectionState) => {
        if (this.conn === conn) useVoiceStore.setState({ connectionState })
      })
      conn.on('speaking', ({ userId, speaking }) =>
        useVoiceStore.getState().setSpeaking(userId, speaking)
      )
      conn.on('peers', (peers) =>
        useVoiceStore.getState().setPeers(peers, useUserStore.getState().me?.id ?? null)
      )
      conn.on('screen', ({ userId, stream }) => {
        if (this.conn !== conn) return
        const screens = new Map(useVoiceStore.getState().screens)
        if (stream) screens.set(userId, stream)
        else screens.delete(userId)
        useVoiceStore.setState({ screens })
      })
      this.statsTimer = setInterval(() => void this.sampleStats(), STATS_MS)
      // Captured even when muted: mute only gates the outgoing track, so unmute is instant.
      await this.startMic()
    } catch (err) {
      if (useVoiceStore.getState().channelId !== channelId) return // superseded by another join
      console.error('[voice] join failed', err)
      playSound('voiceDisconnect')
      this.endSession()
    }
  }

  /**
   * The automatic rejoin after 4013, with backoff (ResyncBackoff). The banner flag stays up until
   * the new call connects. When no attempt is left, the client stays out and shows the failure.
   */
  private rejoin(target: { guildId: string; channelId: string }): void {
    this.endSession()
    const delay = this.resyncBackoff.next()
    if (delay === null) {
      this.resyncBackoff.reset()
      console.warn('[voice] secure rejoin failed: no attempt left')
      playSound('voiceDisconnect')
      useCryptoStore.setState({ voiceResyncing: false, voiceResyncFailed: true })
      return
    }
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null
      void this.connect(target.guildId, target.channelId).finally(() => {
        if (!this.resyncTimer) useCryptoStore.setState({ voiceResyncing: false })
      })
    }, delay)
  }

  /**
   * One rejoin of the dropped call, if the channel is still there and I may still CONNECT.
   * ponytail: one try per drop; ICE needs ~30 s to fail, which bounds a network rejoin loop.
   */
  private rejoinLost(): void {
    const lost = this.lost
    if (!lost || hachiman.gateway.state !== 'ready' || useVoiceStore.getState().channelId) return
    this.lost = null
    const channel = hachiman.cache.channels.get(lost.channelId)
    if (channel?.guildId === lost.guildId) void this.join(channel)
  }

  /** The user joins or leaves: no automatic rejoin waits, and the count starts again. */
  private cancelResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.resyncTimer = null
    this.resync = null
    this.resyncBackoff.reset()
    useCryptoStore.setState({ voiceResyncing: false, voiceResyncFailed: false })
  }

  leaveVoice(): void {
    if (useVoiceStore.getState().channelId) playSound('voiceLeave')
    this.cancelResync()
    this.lost = null
    this.endSession()
  }

  private endSession(): void {
    this.teardown()
    hachiman.leaveVoice()
    useVoiceStore.getState().resetSession()
  }

  toggleMute(): void {
    this.toggleSelfVoice({ selfMute: !hachiman.selfVoice.selfMute })
  }

  toggleDeaf(): void {
    this.toggleSelfVoice({ selfDeaf: !hachiman.selfVoice.selfDeaf })
  }

  /** A user toggle: applies `change` and plays the sound for what actually changed. */
  private toggleSelfVoice(change: Partial<SelfVoice>): void {
    const before = hachiman.selfVoice
    this.setSelfVoice(change)
    const sound = selfVoiceSound(before, hachiman.selfVoice)
    if (sound) playSound(sound)
  }

  /** Opens the OS share picker, then sends the chosen screen or window. Never throws. */
  async startScreenShare(): Promise<void> {
    const conn = this.conn
    if (!conn || this.screen) return
    const quality = usePrefsStore.getState().streamQuality
    let stream: MediaStream
    try {
      stream = await captureScreen(quality)
    } catch (err) {
      console.warn('[voice] screen share cancelled or unavailable', err)
      return
    }
    // Left voice or switched channel while the picker was up.
    if (this.conn !== conn || this.screen) return stopTracks(stream)
    const [track] = stream.getVideoTracks()
    if (!track) return stopTracks(stream)
    // The browser's own "Stop sharing" bar ends the track.
    track.onended = () => {
      if (this.screen === stream) this.stopScreenShare()
    }
    this.screen = stream
    useVoiceStore.setState({ localScreen: stream })
    playSound('streamStart')
    await hachiman.setScreen(track, tuneTrack(track, quality))
  }

  stopScreenShare(): void {
    if (!this.screen) return
    this.releaseScreen()
    playSound('streamStop')
    void hachiman.setScreen(null)
  }

  /** Stops the capture only. Leaving or switching voice ends the share on the wire by itself. */
  private releaseScreen(): void {
    if (this.screen) stopTracks(this.screen)
    this.screen = null
    useVoiceStore.setState({ localScreen: null })
  }

  /** A quality change while live: recapture at the new size and rate, then resend the limits. */
  private async applyStreamQuality(): Promise<void> {
    const track = this.screen?.getVideoTracks()[0]
    if (!track) return
    const quality = usePrefsStore.getState().streamQuality
    try {
      await track.applyConstraints(captureConstraints(quality))
      await hachiman.setScreen(track, tuneTrack(track, quality))
    } catch (err) {
      console.warn('[voice] stream quality change failed', err)
    }
  }

  private setSelfVoice(change: Partial<SelfVoice>): void {
    useVoiceStore.setState(hachiman.setSelfVoice(change))
  }

  private applyOutputDevice(): void {
    void this.conn?.setOutputDevice(usePrefsStore.getState().outputDeviceId)
  }

  /** (Re)starts the mic session on the current input device. Never throws. */
  private async startMic(): Promise<void> {
    this.stopMic()
    const conn = this.conn
    if (!conn) return
    const attempt = this.micAttempt
    try {
      const stream = await captureMic()
      // A stop, restart or teardown happened while the permission prompt was up.
      if (attempt !== this.micAttempt) return stopTracks(stream)
      this.mic = startMicSession(
        stream,
        () => !hachiman.selfVoice.selfMute,
        (speaking) => this.setLocalSpeaking(speaking)
      )
      useVoiceStore.setState({ micActive: true })
      await conn.setMicrophone(stream)
    } catch (err) {
      console.warn('[voice] microphone unavailable', err)
      if (attempt === this.micAttempt) this.stopMic()
    }
  }

  private stopMic(): void {
    this.micAttempt++
    if (!this.mic) return
    this.mic.stop()
    this.mic = null
    void this.conn?.setMicrophone(null)
    useVoiceStore.setState({ micActive: false })
  }

  /** Our VAD result → the `speaking` op + our own speaking indicator. */
  private setLocalSpeaking(speaking: boolean): void {
    this.conn?.setSpeaking(speaking)
    const me = useUserStore.getState().me
    if (me) useVoiceStore.getState().setSpeaking(me.id, speaking)
  }

  private async sampleStats(): Promise<void> {
    const stats = await this.conn?.getStats().catch(() => null)
    useVoiceStore.setState({
      connectionQuality: {
        rttMs: hachiman.gateway.latencyMs,
        jitterMs: stats?.jitterMs ?? null,
        packetLoss: stats?.packetLoss ?? null,
        sampledAt: Date.now()
      }
    })
  }

  private teardown(): void {
    this.releaseScreen()
    this.stopMic()
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    this.conn = null
  }
}

export const voiceService = new VoiceService()
