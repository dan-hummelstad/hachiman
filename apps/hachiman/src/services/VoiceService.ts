import {
  Permissions,
  has,
  type Channel,
  type SelfVoice,
  type VoiceConnection,
  type VoiceTarget,
  voiceScopeId
} from '@hachiman/client'
import { isGuildChannel } from '@/lib/model'
import { ResyncBackoff } from '@/lib/resync-backoff'
import { captureConstraints, tuneTrack, type StreamQuality } from '@/lib/stream-quality'
import { hachiman } from '@/services/client'
import { playSound, selfVoiceSound } from '@/services/SoundService'
import { setCryptoFatal, useCryptoStore } from '@/stores/cryptoStore'
import { usePrefsStore, type NoiseSuppression, type UserAudio } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const STATS_MS = 2_000
const VAD_MS = 50
const VAD_THRESHOLD = 0.02 // RMS
const VAD_HANGOVER_MS = 300
/** RNNoise works on 48 kHz frames. */
const RNNOISE_SAMPLE_RATE = 48_000
/** Media close codes (§8). */
const MEDIA_UNSUPPORTED = 4012
/**
 * Drops that a rejoin can fix: the network (1006, also ICE failed) and a media node shutdown
 * (1001). Not a kick, a replace by another device or an E2EE failure: a rejoin would undo it or
 * fail again, for the whole room.
 */
const REJOIN_CODES = new Set([1001, 1006])
const REJOIN_DELAY_MS = 1_000

/** A captured microphone, its noise suppression, the soundboard mixer and the voice-activity detector. */
interface MicSession {
  /** What goes on the wire: the mix of the (denoised) mic and the soundboard. */
  stream: MediaStream
  /**
   * Mixes `buffer` into the sent track after the noise suppression, so it is not suppressed, and
   * plays it on this device too. `volume` is 0..1.
   */
  play(buffer: AudioBuffer, volume: number): void
  /** Releases the capture, the audio graph and the detector. */
  stop(): void
}

/**
 * Builds the send path for `raw`: mic → (RNNoise worklet, with `rnnoise`) → mixer → a new track.
 * The soundboard joins at the mixer. Every mode has the graph, so a sound can always be mixed in.
 * Runs local voice-activity detection on the mix. `onSpeaking` fires on changes only, and with
 * `false` on stop. `live()` gates it, so a muted user never shows as speaking. Mute stays in the
 * client (`replaceTrack(null)` on the sender), so it keeps the SFrame sender transform; it also
 * silences the soundboard, so the UI disables the soundboard while muted.
 */
async function startMicSession(
  raw: MediaStream,
  rnnoise: boolean,
  live: () => boolean,
  onSpeaking: (speaking: boolean) => void
): Promise<MicSession> {
  const audioCtx = new AudioContext(rnnoise ? { sampleRate: RNNOISE_SAMPLE_RATE } : undefined)
  // A context made without a recent user gesture (an automatic rejoin) can start suspended, and a
  // suspended graph sends silence.
  void audioCtx.resume().catch(() => undefined)
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  const source = audioCtx.createMediaStreamSource(raw)
  const mixer = audioCtx.createGain()
  const dest = audioCtx.createMediaStreamDestination()
  dest.channelCount = 1
  mixer.connect(dest)
  mixer.connect(analyser)
  let denoiser: { destroy(): void } | null = null
  if (rnnoise) {
    try {
      const { createRnnoiseNode } = await import('@/lib/rnnoise')
      const node = await createRnnoiseNode(audioCtx)
      source.connect(node).connect(mixer)
      denoiser = node
    } catch (err) {
      // Fail soft to the browser's own suppression rather than to none.
      console.warn('[voice] RNNoise unavailable, using browser noise suppression', err)
      const [track] = raw.getAudioTracks()
      await track
        ?.applyConstraints({ ...micConstraints(true), deviceId: track.getSettings().deviceId })
        .catch(() => undefined)
    }
  }
  if (!denoiser) source.connect(mixer)
  applySink(audioCtx)
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
    stream: dest.stream,
    play: (buffer, volume) => {
      void audioCtx.resume().catch(() => undefined)
      const node = audioCtx.createBufferSource()
      node.buffer = buffer
      const gain = audioCtx.createGain()
      gain.gain.value = volume
      node.connect(gain)
      gain.connect(mixer)
      // The presser hears it too. The mic itself never goes to the speakers.
      gain.connect(audioCtx.destination)
      node.onended = () => gain.disconnect()
      node.start()
    },
    stop: () => {
      clearInterval(vad)
      denoiser?.destroy()
      void audioCtx.close()
      stopTracks(raw)
      stopTracks(dest.stream)
      report(false)
    }
  }
}

/** Sends the local soundboard playback to the chosen output device, where the browser can. */
function applySink(ctx: AudioContext): void {
  const id = usePrefsStore.getState().outputDeviceId
  const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
  if (id && sinkable.setSinkId) void sinkable.setSinkId(id).catch(() => undefined)
}

/** A DM or group DM: its call is a voice room too (§6 "DM calls"). */
export function isDmCall(channel: Channel): boolean {
  return channel.type === 'dm' || channel.type === 'group_dm'
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop())
}

/** With RNNoise on, the browser's suppression is off: running both double-processes the voice. */
function micConstraints(browserNoiseSuppression: boolean): MediaTrackConstraints {
  return {
    echoCancellation: usePrefsStore.getState().echoCancellation,
    noiseSuppression: browserNoiseSuppression,
    autoGainControl: true
  }
}

function captureMic(mode: NoiseSuppression): Promise<MediaStream> {
  const deviceId = usePrefsStore.getState().inputDeviceId
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...micConstraints(mode === 'browser'),
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {})
    }
  })
}

/**
 * Share audio as captured: no voice processing. `restrictOwnAudio` (Chromium) keeps this page's
 * own playback, the call, out of a system audio capture, so viewers do not hear themselves. A
 * browser that does not know a constraint ignores it.
 */
const SCREEN_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  restrictOwnAudio: true
} as MediaTrackConstraints

/**
 * `audio`: ask for the share's audio too. The browser picker offers it where it can (a tab, or
 * the system on Windows and ChromeOS); Electron gets it from the main process (screen-share.ts).
 */
function captureScreen(q: StreamQuality, audio: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: captureConstraints(q),
    audio: audio ? SCREEN_AUDIO : false,
    // Chromium: offer "Also share system audio" in its picker.
    ...(audio ? { systemAudio: 'include' } : {})
  } as DisplayMediaStreamOptions)
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
  private lost: VoiceTarget | null = null
  /** Set by 'voiceMoved': the drop that follows is the move, and the next connection is the new call. */
  private moving = false
  /** Set by media close 4013: the drop that follows rejoins this target instead of ending. */
  private resync: VoiceTarget | null = null
  /** Consecutive 4013 rejoins without keys, and the timer of the next one. */
  private readonly resyncBackoff = new ResyncBackoff()
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  /** The push-to-talk key is down (focused window only: hooks/use-app-shortcuts.ts). */
  private pttHeld = false

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
        if (this.moving) {
          this.moving = false
          this.adopt(vc)
        }
        return
      }
      if (this.moving) return // the old call of a move
      const resync = this.resync
      this.resync = null
      if (resync) return void this.rejoin(resync)
      if (!this.conn) return
      // No close code: the client dropped the call itself (a new gateway session).
      const code = this.conn.closeCode
      const { guildId, channelId } = useVoiceStore.getState()
      playSound('voiceDisconnect')
      this.endSession()
      if (!channelId || (code !== null && !REJOIN_CODES.has(code))) return
      this.lost = { guildId, channelId }
      setTimeout(() => this.rejoinLost(), REJOIN_DELAY_MS)
    })
    // A moderator moved me (§6 "Voice moderation"): the client follows without op 4.
    hachiman.on('voiceMoved', ({ guildId, channelId }) => {
      this.cancelResync()
      this.lost = null
      this.teardown()
      this.moving = true
      useVoiceStore.setState({
        guildId,
        channelId,
        localJoinedAt: Date.now(),
        connectionState: 'new',
        screens: new Map(),
        watching: new Set()
      })
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
    // A share that ends also ends the watching: the next share of that user starts unwatched.
    useVoiceStore.subscribe((s) => {
      if (s.watching.size === 0) return
      // voiceScopeId: the guild, or the DM channel of a DM call.
      const states = s.channelId
        ? s.voiceStates.get(voiceScopeId({ guildId: s.guildId, channelId: s.channelId }))
        : undefined
      const live = [...s.watching].filter((id) => {
        const vs = states?.get(id)
        return vs?.selfStream === true && vs.channelId === s.channelId
      })
      if (live.length !== s.watching.size) useVoiceStore.setState({ watching: new Set(live) })
    })
    // Media forwards a screen only to the viewers that watch it (§8 screen_subscribe).
    useVoiceStore.subscribe((s, prev) => {
      if (s.watching !== prev.watching) this.conn?.setScreenSubscriptions(s.watching)
    })
    // Device changes from user settings apply to the live session.
    usePrefsStore.subscribe((s, prev) => {
      const recapture =
        s.inputDeviceId !== prev.inputDeviceId ||
        s.echoCancellation !== prev.echoCancellation ||
        s.noiseSuppression !== prev.noiseSuppression
      if (recapture && this.conn) void this.startMic()
      if (s.micBitrate !== prev.micBitrate) this.applyMicBitrate()
      if (s.outputDeviceId !== prev.outputDeviceId) this.applyOutputDevice()
      if (s.streamQuality !== prev.streamQuality) void this.applyStreamQuality()
      if (s.userAudio !== prev.userAudio) this.applyUserAudio(prev.userAudio)
      if (s.voiceInputMode !== prev.voiceInputMode) this.applyInputGate()
      if (s.streamAudio !== prev.streamAudio) this.applyStreamAudio(prev.streamAudio)
    })
  }

  /**
   * Join a guild voice channel if I may CONNECT there, or the call of a DM / group DM (§6 "DM
   * calls"); otherwise a no-op. `muted` ("Watch stream", N18) turns self-mute on before the join,
   * so no audio goes out from the start.
   */
  join(channel: Channel, opts: { muted?: boolean } = {}): Promise<void> {
    if (isDmCall(channel)) return this.joinVoice(null, channel.id, opts)
    if (
      channel.type !== 'voice' ||
      !isGuildChannel(channel) ||
      !has(hachiman.permissionsFor(channel.id), Permissions.CONNECT)
    )
      return Promise.resolve()
    return this.joinVoice(channel.guildId, channel.id, opts)
  }

  /** A join by the user. It cancels a waiting automatic rejoin. */
  joinVoice(
    guildId: string | null,
    channelId: string,
    opts: { muted?: boolean } = {}
  ): Promise<void> {
    this.cancelResync()
    this.lost = null
    if (opts.muted) this.setSelfVoice({ selfMute: true })
    return this.connect(guildId, channelId)
  }

  private async connect(guildId: string | null, channelId: string): Promise<void> {
    if (useVoiceStore.getState().channelId === channelId) return
    this.teardown()
    useVoiceStore.setState({
      guildId,
      channelId,
      localJoinedAt: Date.now(),
      connectionState: 'new',
      screens: new Map(),
      watching: new Set()
    })
    try {
      const conn = await hachiman.joinVoice(guildId, channelId)
      this.conn = conn
      playSound('voiceJoin')
      await this.wire(conn)
    } catch (err) {
      if (useVoiceStore.getState().channelId !== channelId) return // superseded by another join
      console.error('[voice] join failed', err)
      playSound('voiceDisconnect')
      this.endSession()
    }
  }

  /** The new call of a move: the client opened it (no joinVoice here). */
  private adopt(conn: VoiceConnection): void {
    this.conn = conn
    playSound('voiceJoin')
    this.wire(conn).catch((err: unknown) => console.error('[voice] move failed', err))
  }

  /** Mirrors a new call into the store and starts the mic. */
  private async wire(conn: VoiceConnection): Promise<void> {
    // A "Watch stream" clicked while the join was in flight. A move clears `watching` first.
    conn.setScreenSubscriptions(useVoiceStore.getState().watching)
    this.applyOutputDevice()
    this.applyUserAudio()
    this.applyStreamAudio()
    this.applyMicBitrate()
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
  }

  /**
   * The automatic rejoin after 4013, with backoff (ResyncBackoff). The banner flag stays up until
   * the new call connects. When no attempt is left, the client stays out and shows the failure.
   */
  private rejoin(target: VoiceTarget): void {
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

  /**
   * Mixes a soundboard sound into my sent track. False when it cannot be heard: no call, no mic,
   * or self-muted (mute drops the sent track, sound included).
   */
  playSoundboard(buffer: AudioBuffer, volume: number): boolean {
    if (!this.conn || !this.mic || hachiman.selfVoice.selfMute) return false
    this.mic.play(buffer, volume)
    return true
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

  /**
   * Push to talk: the key went down (true) or up. Only the sent track changes; no voice state
   * goes out, so the others see no mute icon per press. The VAD still drives the speaking ring.
   */
  setPushToTalk(held: boolean): void {
    if (held === this.pttHeld) return
    this.pttHeld = held
    this.applyInputGate()
  }

  /** Whether my mic goes out: not self-muted, and in push-to-talk mode only while the key is down. */
  private transmitting(): boolean {
    if (hachiman.selfVoice.selfMute) return false
    return usePrefsStore.getState().voiceInputMode !== 'pushToTalk' || this.pttHeld
  }

  /**
   * Push to talk gates the sent track itself (`enabled`; a disabled track sends silence), not the
   * sender. Self-mute stays with the client (`replaceTrack(null)`), so the two never race: an
   * unmute while push to talk is idle puts back a track that carries no audio. Synchronous, so
   * no frame of live audio goes out between a key-up and the gate.
   */
  private applyInputGate(): void {
    const open = usePrefsStore.getState().voiceInputMode !== 'pushToTalk' || this.pttHeld
    for (const t of this.mic?.stream.getAudioTracks() ?? []) t.enabled = open
  }

  /**
   * "Watch stream" / "Stop watching" for `userId`'s live share. The store subscription above sends
   * the new set to media (§8 screen_subscribe), so an unwatched share is not sent to this client.
   */
  setWatching(userId: string, watch: boolean): void {
    const watching = new Set(useVoiceStore.getState().watching)
    if (watch) watching.add(userId)
    else watching.delete(userId)
    useVoiceStore.setState({ watching })
  }

  /**
   * Opens the OS share picker, then sends the chosen screen or window, and its audio when the
   * capture has one (`audio` asks for it). While sharing, the pick changes the source: the new
   * video and audio tracks replace the old ones on the same senders (no renegotiation), then the
   * old capture stops. Never throws.
   */
  async startScreenShare(opts: { audio?: boolean } = {}): Promise<void> {
    const conn = this.conn
    if (!conn) return
    const prev = this.screen
    const quality = usePrefsStore.getState().streamQuality
    let stream: MediaStream
    try {
      stream = await captureScreen(quality, opts.audio ?? true)
    } catch (err) {
      console.warn('[voice] screen share cancelled or unavailable', err)
      return
    }
    // Left voice, switched channel, or the share started, stopped or changed during the picker.
    if (this.conn !== conn || this.screen !== prev) return stopTracks(stream)
    const [track] = stream.getVideoTracks()
    if (!track) return stopTracks(stream)
    // The browser's own "Stop sharing" bar ends the track. A replaced capture is no longer
    // `this.screen`, so its end does not stop the share.
    track.onended = () => {
      if (this.screen === stream) this.stopScreenShare()
    }
    this.screen = stream
    useVoiceStore.setState({ localScreen: stream })
    if (!prev) playSound('streamStart')
    try {
      // The share's own audio is never played here: the SFU sends it to the viewers only.
      await Promise.all([
        hachiman.setScreen(track, tuneTrack(track, quality)),
        conn.setScreenAudio(stream.getAudioTracks()[0] ?? null)
      ])
    } finally {
      if (prev) stopTracks(prev)
    }
  }

  stopScreenShare(): void {
    if (!this.screen) return
    this.releaseScreen()
    playSound('streamStop')
    void hachiman.setScreen(null)
    void this.conn?.setScreenAudio(null)
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

  private applyMicBitrate(): void {
    void this.conn?.setMicBitrate(usePrefsStore.getState().micBitrate)
  }

  private applyOutputDevice(): void {
    void this.conn?.setOutputDevice(usePrefsStore.getState().outputDeviceId)
  }

  /**
   * The local volume and mute of each user (prefs) on the call. `prev` also resets the users
   * whose entry was removed, which means the default.
   */
  private applyUserAudio(prev: Record<string, UserAudio> = {}): void {
    const conn = this.conn
    if (!conn) return
    const now = usePrefsStore.getState().userAudio
    for (const userId of new Set([...Object.keys(prev), ...Object.keys(now)])) {
      const a = now[userId]
      if (a === prev[userId]) continue
      conn.setOutputVolume(userId, !a ? 1 : a.muted ? 0 : a.volume)
    }
  }

  /** The local volume and mute of each user's screen share audio, as `applyUserAudio`. */
  private applyStreamAudio(prev: Record<string, UserAudio> = {}): void {
    const conn = this.conn
    if (!conn) return
    const now = usePrefsStore.getState().streamAudio
    for (const userId of new Set([...Object.keys(prev), ...Object.keys(now)])) {
      const a = now[userId]
      if (a === prev[userId]) continue
      conn.setScreenVolume(userId, !a ? 1 : a.muted ? 0 : a.volume)
    }
  }

  /** (Re)starts the mic session on the current input device. Never throws. */
  private async startMic(): Promise<void> {
    this.stopMic()
    const conn = this.conn
    if (!conn) return
    const attempt = this.micAttempt
    try {
      const mode = usePrefsStore.getState().noiseSuppression
      const stream = await captureMic(mode)
      // A stop, restart or teardown happened while the permission prompt was up.
      if (attempt !== this.micAttempt) return stopTracks(stream)
      const mic = await startMicSession(
        stream,
        mode === 'rnnoise',
        () => this.transmitting(),
        (speaking) => this.setLocalSpeaking(speaking)
      )
      // Superseded while the RNNoise worklet loaded.
      if (attempt !== this.micAttempt) return mic.stop()
      this.mic = mic
      // Before the sender gets the track: in push-to-talk mode it starts closed.
      this.applyInputGate()
      useVoiceStore.setState({ micActive: true })
      await conn.setMicrophone(mic.stream)
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
