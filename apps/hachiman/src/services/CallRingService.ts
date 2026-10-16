import { voiceScopeId } from '@hachiman/client'
import { keepRinging, ringOf, type IncomingRing } from '@/lib/call-ring'
import { openChannelView } from '@/lib/navigation'
import { hachiman } from '@/services/client'
import { notifyRing } from '@/services/PushService'
import { playSound } from '@/services/SoundService'
import { voiceService } from '@/services/VoiceService'
import { useRingStore } from '@/stores/ringStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** The ring sound repeats this often while a call rings. */
const RING_REPEAT_MS = 2_500

/**
 * Incoming DM calls (§6 "DM calls"). CALL_RING starts the ring: `ringStore` and a looped 'ring'
 * sound. It stops on a decline or accept, at the timeout, or when the voice states say so
 * (`keepRinging`). The stop is local: nothing goes on the wire.
 */
class CallRingService {
  private loop: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `startHachiman()` calls it once. */
  start(): void {
    hachiman.on('CALL_RING', (d) => {
      const myId = useUserStore.getState().me?.id ?? null
      const ring = ringOf(d, myId, hachiman.cache.blocks, Date.now())
      if (!ring) return
      this.ring(ring)
      this.check()
    })
    useVoiceStore.subscribe((s, p) => {
      if (s.voiceStates !== p.voiceStates || s.channelId !== p.channelId) this.check()
    })
  }

  /** Join the ringing call and show it. */
  accept(): void {
    const ring = useRingStore.getState().ring
    this.stop()
    const channel = ring ? hachiman.cache.channels.get(ring.channelId) : undefined
    if (!channel) return
    openChannelView(channel)
    void voiceService.join(channel)
  }

  /** Stop ringing on this device. ponytail: the other devices of the user ring until the timeout. */
  decline(): void {
    this.stop()
  }

  private ring(ring: IncomingRing): void {
    this.stop()
    useRingStore.setState({ ring })
    playSound('ring')
    notifyRing(ring.channelId, ring.callerId)
    this.loop = setInterval(() => playSound('ring'), RING_REPEAT_MS)
    this.timer = setTimeout(() => this.stop(), Math.max(0, ring.until - Date.now()))
  }

  private check(): void {
    const ring = useRingStore.getState().ring
    const myId = useUserStore.getState().me?.id
    if (!ring || !myId) return
    // The client cache, not the store mirror: CALL_RING can arrive before the mirror ran.
    const states = hachiman.cache.voiceStates.get(
      voiceScopeId({ guildId: null, channelId: ring.channelId })
    )
    const { channelId } = useVoiceStore.getState()
    const oneToOne = (hachiman.cache.channels.get(ring.channelId)?.recipients?.length ?? 0) <= 1
    if (!keepRinging(ring, states, myId, channelId, oneToOne)) this.stop()
  }

  private stop(): void {
    if (this.loop) clearInterval(this.loop)
    if (this.timer) clearTimeout(this.timer)
    this.loop = null
    this.timer = null
    if (useRingStore.getState().ring) useRingStore.setState({ ring: null })
  }
}

export const callRingService = new CallRingService()
