/**
 * The Worker entry for RTCRtpScriptTransform (§12.10.2). One Worker per call:
 *
 *   new RTCRtpScriptTransform(worker, { role, track, codec, userId, port } satisfies FrameTransformOptions, [port])
 *
 * The crypto Worker sends FrameKeyMessage on the port. Every transformer whose options carry the
 * same port shares one FrameKeyRing. The logic is in transform.ts; this file only moves frames.
 * A frame that does not encrypt or decrypt is dropped, never passed through.
 */
import type { FrameKeyMessage, FrameTransformOptions } from '../api'
import { FrameKeyRing } from './transform'

const STATS_INTERVAL_MS = 2_000

/** The parts of the WebRTC encoded-transform API that this file uses (not in lib.dom). */
interface EncodedFrame {
  data: ArrayBuffer
}
interface ScriptTransformer {
  readonly readable: ReadableStream<EncodedFrame>
  readonly writable: WritableStream<EncodedFrame>
  readonly options: unknown
}
interface TransformScope {
  onrtctransform: ((event: { transformer: ScriptTransformer }) => void) | null
}

const rings = new WeakMap<MessagePort, FrameKeyRing>()

function ringFor(port: MessagePort): FrameKeyRing {
  const known = rings.get(port)
  if (known !== undefined) return known
  const r = new FrameKeyRing()
  rings.set(port, r)
  const timer = setInterval(() => {
    port.postMessage(r.snapshot())
    if (r.isClosed) clearInterval(timer)
  }, STATS_INTERVAL_MS)
  port.onmessage = (ev: MessageEvent<FrameKeyMessage>) => {
    r.handle(ev.data, Date.now())
    if (r.isClosed) {
      port.postMessage(r.snapshot())
      clearInterval(timer)
      port.close()
    }
  }
  port.start()
  return r
}

function validOptions(o: unknown): o is FrameTransformOptions {
  if (typeof o !== 'object' || o === null) return false
  const x = o as Partial<FrameTransformOptions>
  return (
    (x.role === 'send' || x.role === 'recv') &&
    (x.track === 'audio' || x.track === 'video' || x.track === 'screen-audio') &&
    (x.codec === (x.track === 'video' ? 'vp8' : 'opus')) &&
    (x.role === 'send' || typeof x.userId === 'string') &&
    x.port instanceof MessagePort
  )
}

;(self as unknown as TransformScope).onrtctransform = (event) => {
  const { transformer } = event
  const options = transformer.options
  // Without valid options there is no key: drop every frame.
  const ring = validOptions(options) ? ringFor(options.port) : null
  const stream = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      if (ring === null || !validOptions(options)) return
      const data = new Uint8Array(frame.data)
      const r = options.role === 'send' ? await ring.encrypt(data, options) : await ring.decrypt(data, options, Date.now())
      if (!('frame' in r)) return
      frame.data = r.frame.byteOffset === 0 && r.frame.buffer.byteLength === r.frame.byteLength ? (r.frame.buffer as ArrayBuffer) : r.frame.slice().buffer
      controller.enqueue(frame)
    },
  })
  void transformer.readable.pipeThrough(stream).pipeTo(transformer.writable)
}
