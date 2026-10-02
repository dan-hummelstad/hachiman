/**
 * VoiceE2eeDelegate (§10) over the crypto Worker (CryptoApi.voice*, §8, §12.10).
 *
 * - One delegate and one transform Worker per call. The delegate never makes a second Worker.
 * - One sender transform per (call, track) (§12.10.2). A second request for a track gets the
 *   same transform, so a CTR that starts again at 0 never meets the same key.
 * - Each transform gets its own MessageChannel: one end goes to the transform Worker in the
 *   RTCRtpScriptTransform options, the other to the crypto Worker (voiceAttachTransform), which
 *   sends the frame keys on it.
 */
import type {
  VoiceE2eeClientOp as ClientVoiceClientOp,
  VoiceE2eeDelegate,
  VoiceE2eeServerOp as ClientVoiceServerOp,
  VoiceRosterEntry as ClientVoiceRosterEntry,
  VoiceTrackKind
} from '@hachiman/client'
import type {
  CryptoApi,
  FrameTransformOptions,
  VoiceE2eeClientOp,
  VoiceE2eeServerOp,
  VoiceRosterEntry
} from '@hachiman/crypto'

/** Both directions assignable: the client and crypto copies of a wire shape are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sameShapes: [
  Same<ClientVoiceServerOp, VoiceE2eeServerOp>,
  Same<ClientVoiceClientOp, VoiceE2eeClientOp>,
  Same<ClientVoiceRosterEntry, VoiceRosterEntry>
] = [true, true, true]
void sameShapes

export type VoiceCrypto = Pick<CryptoApi, 'voiceHandle' | 'voiceAttachTransform' | 'voiceStop'> & {
  /** CryptoApi.voiceStart. The Worker also reads `guildId`: it puts it in the group descriptor. */
  voiceStart(opts: { channelId: string; guildId: string }): ReturnType<CryptoApi['voiceStart']>
}

export interface VoiceE2eeDeps {
  crypto: VoiceCrypto
  target: { guildId: string; channelId: string }
  /** createTransformWorker from @hachiman/crypto. Called once, here. */
  createWorker(): Worker
  /** `new RTCRtpScriptTransform(worker, options, transfer)`. */
  createTransform(
    worker: Worker,
    options: FrameTransformOptions,
    transfer: Transferable[]
  ): RTCRtpScriptTransform
  createChannel(): MessageChannel
  /** The call has a handle (after start) or ended (null). */
  onHandle(handle: string | null): void
}

const CODEC: Record<VoiceTrackKind, FrameTransformOptions['codec']> = {
  audio: 'opus',
  video: 'vp8'
}

export function createVoiceE2ee(deps: VoiceE2eeDeps): VoiceE2eeDelegate {
  const worker = deps.createWorker()
  const senders = new Map<VoiceTrackKind, RTCRtpScriptTransform>()
  /** Crypto-side ports that wait for the handle. */
  let unattached: MessagePort[] = []
  let handle: string | null = null
  let closed = false

  const attach = (port: MessagePort): void => {
    if (handle === null) {
      unattached.push(port)
      return
    }
    // A port without keys drops every frame: a failure here fails closed.
    void deps.crypto
      .voiceAttachTransform(handle, port)
      .catch((e: unknown) => console.warn('[voice] frame key port failed', e))
  }

  const transform = (options: Omit<FrameTransformOptions, 'port'>): RTCRtpScriptTransform => {
    if (closed) throw new Error('voice e2ee: the call ended')
    const channel = deps.createChannel()
    const t = deps.createTransform(worker, { ...options, port: channel.port2 }, [channel.port2])
    attach(channel.port1)
    return t
  }

  return {
    async start() {
      const s = await deps.crypto.voiceStart({
        channelId: deps.target.channelId,
        guildId: deps.target.guildId
      })
      if (closed) {
        void deps.crypto.voiceStop(s.handle).catch(() => {})
        throw new Error('voice e2ee: the call ended')
      }
      handle = s.handle
      deps.onHandle(handle)
      const waiting = unattached
      unattached = []
      waiting.forEach(attach)
      return { keyPackage: s.keyPackage }
    },
    handle(op) {
      if (handle === null) return Promise.reject(new Error('voice e2ee: not started'))
      return deps.crypto.voiceHandle(handle, op)
    },
    senderTransform(track) {
      let t = senders.get(track)
      if (!t) {
        t = transform({ role: 'send', track, codec: CODEC[track], userId: null })
        senders.set(track, t)
      }
      return t
    },
    receiverTransform(userId, track) {
      return transform({ role: 'recv', track, codec: CODEC[track], userId })
    },
    close() {
      if (closed) return
      closed = true
      for (const p of unattached) p.close()
      unattached = []
      if (handle !== null) void deps.crypto.voiceStop(handle).catch(() => {})
      handle = null
      deps.onHandle(null)
      worker.terminate()
    }
  }
}
