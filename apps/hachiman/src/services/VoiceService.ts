import {
  Permissions,
  has,
  type Channel,
  type SelfVoice,
  type VoiceConnection
} from '@hachiman/client'
import { isGuildChannel } from '@/lib/model'
import { hachiman } from '@/services/hachiman'
import { usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const STATS_MS = 2_000
const VAD_MS = 50
const VAD_THRESHOLD = 0.02 // RMS
const VAD_HANGOVER_MS = 300

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

/**
 * Global single voice session over HachimanClient.joinVoice / VoiceConnection. Mute/deafen policy
 * lives in the client (`setSelfVoice`); this service mirrors the result into `useVoiceStore`.
 */
class VoiceService {
  private conn: VoiceConnection | null = null
  private mic: MicSession | null = null
  /** Bumped by every mic start/stop, so a late getUserMedia can tell it was superseded. */
  private micAttempt = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null

  /** Wires the client and prefs subscriptions. `startHachiman()` calls it once. */
  start(): void {
    // The persisted prefs seed the client, which owns mute/deafen state from here on.
    const { ownMute, selfDeaf } = useVoiceStore.getState()
    this.setSelfVoice({ selfMute: ownMute, selfDeaf })
    // Dropped underneath us (kicked / replaced / media drop / gateway disconnect on sign-out).
    // Our own leave/switch clears `this.conn` first, so those don't land here.
    hachiman.on('voice', (vc) => {
      if (vc || !this.conn) return
      this.teardown()
      useVoiceStore.getState().resetSession()
    })
    // Device changes from user settings apply to the live session.
    usePrefsStore.subscribe((s, prev) => {
      if (s.inputDeviceId !== prev.inputDeviceId && this.conn) void this.startMic()
      if (s.outputDeviceId !== prev.outputDeviceId) this.applyOutputDevice()
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

  async joinVoice(guildId: string, channelId: string): Promise<void> {
    if (useVoiceStore.getState().channelId === channelId) return
    this.teardown()
    useVoiceStore.setState({ guildId, channelId, connectionState: 'new' })
    try {
      const conn = await hachiman.joinVoice(guildId, channelId)
      this.conn = conn
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
      this.statsTimer = setInterval(() => void this.sampleStats(), STATS_MS)
      // Captured even when muted: mute only gates the outgoing track, so unmute is instant.
      await this.startMic()
    } catch (err) {
      if (useVoiceStore.getState().channelId !== channelId) return // superseded by another join
      console.error('[voice] join failed', err)
      this.leaveVoice()
    }
  }

  leaveVoice(): void {
    this.teardown()
    hachiman.leaveVoice()
    useVoiceStore.getState().resetSession()
  }

  toggleMute(): void {
    this.setSelfVoice({ selfMute: !hachiman.selfVoice.selfMute })
  }

  toggleDeaf(): void {
    this.setSelfVoice({ selfDeaf: !hachiman.selfVoice.selfDeaf })
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
    this.stopMic()
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    this.conn = null
  }
}

export const voiceService = new VoiceService()
