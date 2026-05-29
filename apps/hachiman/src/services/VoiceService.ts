import { serversService } from './ServersService'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'
import type { ConnectionQualitySample, SpeakingStateChange } from '@hachiman/hachiman-node'

export class VoiceService {
  private _speakingListener: ((state: SpeakingStateChange) => void) | null = null
  private _connectionQualityListener: ((sample: ConnectionQualitySample) => void) | null = null
  private _connectionCleanup: (() => void) | null = null
  private _activeUrl: string | null = null

  initVoice(url: string): void {
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) return

    this._activeUrl = url
    const store = useVoiceStore.getState()

    this._speakingListener = (state: SpeakingStateChange) => {
      if (state.speaking) {
        store.addSpeaking(state.user.session)
      } else {
        store.removeSpeaking(state.user.session)
      }
    }

    server.on('speakingStateChange', this._speakingListener)

    // Surface measured connection quality into the store: RTT from the client
    // library's control-channel Ping round-trip, and packet-loss / jitter from
    // the WebRTC voice path's RTCStats. The sample shape mirrors voiceStore's
    // ConnectionQuality slot, so it flows straight in.
    this._connectionQualityListener = (sample: ConnectionQualitySample) => {
      store.setConnectionQuality(sample)
    }

    server.on('connectionQuality', this._connectionQualityListener)

    // Track WebRTC connection state
    const webrtcVoice = server.mumbleClient.webrtcVoice
    if (webrtcVoice) {
      const sub = webrtcVoice.connectionState.subscribe((state) => {
        store.setVoiceConnected(state === 'connected')
      })
      this._connectionCleanup = () => sub.unsubscribe()
    }
  }

  /**
   * Join voice on the given channel: start the microphone and record the
   * voice-connected channel in the store. Assumes the caller has already
   * moved the user into the channel (Mumble-side).
   */
  async joinVoice(url: string, channelId: number): Promise<void> {
    const store = useVoiceStore.getState()
    const userStore = useUserStore.getState()
    store.setVoiceChannel(url, channelId)

    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) return

    if (!userStore.selfMute && !userStore.selfDeaf) {
      await server.startMicrophone().catch((err) => {
        console.warn('Failed to start microphone:', err)
      })
      store.setMicActive(true)
    }
  }

  /**
   * Leave voice on the given server: stop the microphone and clear the
   * voice-connected channel for this server.
   */
  async leaveVoice(url: string): Promise<void> {
    const store = useVoiceStore.getState()
    const server = serversService.getServer(url)
    if (server) {
      server.stopMicrophone()
    }
    store.setMicActive(false)
    store.setVoiceChannel(url, null)
  }

  async startMicrophone(url: string): Promise<void> {
    const store = useVoiceStore.getState()
    const userStore = useUserStore.getState()
    if (userStore.selfMute || userStore.selfDeaf) return

    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) return

    await server.startMicrophone()
    store.setMicActive(true)
  }

  stopMicrophone(url: string): void {
    const store = useVoiceStore.getState()
    const server = serversService.getServer(url)
    if (!server) return

    server.stopMicrophone()
    store.setMicActive(false)
  }

  /**
   * Toggle the user's self-mute preference. `url` is the server to push the
   * state change to; pass null (or any disconnected url) to just flip the
   * local pref. The pref is global — when the user later joins voice on a
   * server, `joinVoice` honours it.
   */
  async toggleMute(url: string | null): Promise<void> {
    const store = useVoiceStore.getState()
    const userStore = useUserStore.getState()
    const wasMuted = userStore.selfMute
    userStore.setSelfMute(!wasMuted)

    const server = url ? serversService.getServer(url) : null
    if (!server || !server.isConnected()) return

    if (wasMuted) {
      await server.mumbleClient.self?.setSelfMute(false).catch((err) => {
        console.warn('setSelfMute(false) failed:', err)
      })
      await server.startMicrophone()
      store.setMicActive(true)
    } else {
      server.stopMicrophone()
      store.setMicActive(false)
      await server.mumbleClient.self?.setSelfMute(true).catch((err) => {
        console.warn('setSelfMute(true) failed:', err)
      })
    }
  }

  /** Same shape as `toggleMute` — null/disconnected url just flips the pref. */
  async toggleDeaf(url: string | null): Promise<void> {
    const store = useVoiceStore.getState()
    const userStore = useUserStore.getState()
    const wasDeaf = userStore.selfDeaf

    if (wasDeaf) {
      userStore.setSelfDeaf(false)
    } else {
      // Deafen implies mute — same semantics as Mumble's native client.
      userStore.setSelfDeaf(true)
      userStore.setSelfMute(true)
    }

    const server = url ? serversService.getServer(url) : null
    if (!server || !server.isConnected()) return

    if (wasDeaf) {
      await server.mumbleClient.self?.setSelfDeaf(false).catch((err) => {
        console.warn('setSelfDeaf(false) failed:', err)
      })
      if (!useUserStore.getState().selfMute) {
        await server.startMicrophone()
        store.setMicActive(true)
      }
    } else {
      server.stopMicrophone()
      store.setMicActive(false)
      await server.mumbleClient.self?.setSelfDeaf(true).catch((err) => {
        console.warn('setSelfDeaf(true) failed:', err)
      })
      await server.mumbleClient.self?.setSelfMute(true).catch((err) => {
        console.warn('setSelfMute(true) failed:', err)
      })
    }
  }

  cleanup(): void {
    if (this._activeUrl) {
      const server = serversService.getServer(this._activeUrl)
      if (server) {
        if (this._speakingListener) {
          server.off('speakingStateChange', this._speakingListener)
        }
        if (this._connectionQualityListener) {
          server.off('connectionQuality', this._connectionQualityListener)
        }
      }
    }
    this._connectionCleanup?.()
    this._connectionCleanup = null
    this._speakingListener = null
    this._connectionQualityListener = null
    this._activeUrl = null
    useVoiceStore.getState().reset()
  }
}

export const voiceService = new VoiceService()
