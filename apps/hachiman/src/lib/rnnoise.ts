import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

let wasm: Promise<ArrayBuffer> | null = null

/**
 * An RNNoise AudioWorklet node on `ctx`, which must run at 48 kHz. It downmixes to mono. The wasm
 * is fetched once per app run; the worklet compiles it, which needs `'wasm-unsafe-eval'` in the
 * CSP (§11). Call `destroy()` before the context closes.
 */
export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  wasm ??= loadRnnoise({ url: wasmUrl, simdUrl }).catch((err: unknown) => {
    wasm = null
    throw err
  })
  const [wasmBinary] = await Promise.all([wasm, ctx.audioWorklet.addModule(workletUrl)])
  const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })
  node.channelCount = 1
  node.channelCountMode = 'explicit'
  return node
}
