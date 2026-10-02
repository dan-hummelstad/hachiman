import { describe, expect, it } from 'vitest'
import type { FrameTransformOptions, VoiceE2eeServerOp } from '@hachiman/crypto'
import { createVoiceE2ee, type VoiceCrypto, type VoiceE2eeDeps } from './voice-e2ee'

/** Fakes for the Worker, the ports and RTCRtpScriptTransform, with a log of what happened. */
interface Harness {
  deps: VoiceE2eeDeps
  log: string[]
  transforms: { options: FrameTransformOptions; transfer: unknown[] }[]
  attached: unknown[]
  workers: () => number
}

function harness(): Harness {
  const log: string[] = []
  let workers = 0
  let ports = 0
  const transforms: { options: FrameTransformOptions; transfer: unknown[] }[] = []
  const attached: unknown[] = []
  const crypto: VoiceCrypto = {
    voiceStart: async (opts) => {
      log.push(`start ${opts.guildId}/${opts.channelId}`)
      return { handle: 'h-1', keyPackage: 'KP' }
    },
    voiceHandle: async (handle, op) => {
      log.push(`handle ${handle} ${op.op}`)
      return []
    },
    voiceAttachTransform: async (handle, port) => {
      attached.push(port)
      log.push(`attach ${handle}`)
    },
    voiceStop: async (handle) => {
      log.push(`stop ${handle}`)
    }
  }
  const deps: VoiceE2eeDeps = {
    crypto,
    target: { guildId: 'g-1', channelId: 'c-voice' },
    createWorker: () => {
      workers++
      return { terminate: () => log.push('terminate') } as unknown as Worker
    },
    createTransform: (_w, options, transfer) => {
      transforms.push({ options, transfer })
      return { options } as unknown as RTCRtpScriptTransform
    },
    createChannel: () => {
      const n = ++ports
      const port = (side: string): { side: string; close: () => void } => ({
        side: `${side}${n}`,
        close: () => log.push(`close ${side}${n}`)
      })
      return { port1: port('crypto'), port2: port('frame') } as unknown as MessageChannel
    },
    onHandle: (h) => log.push(`handle-state ${h}`)
  }
  return { deps, log, transforms, attached, workers: () => workers }
}

describe('createVoiceE2ee', () => {
  it('makes one transform Worker per call and starts with the guild of the call', async () => {
    const h = harness()
    const e2ee = createVoiceE2ee(h.deps)
    expect(await e2ee.start()).toEqual({ keyPackage: 'KP' })
    expect(h.workers()).toBe(1)
    expect(h.log).toContain('start g-1/c-voice')
  })

  it('makes each sender transform once per call and track', async () => {
    const h = harness()
    const e2ee = createVoiceE2ee(h.deps)
    await e2ee.start()
    const audio = e2ee.senderTransform('audio')
    expect(e2ee.senderTransform('audio')).toBe(audio)
    const video = e2ee.senderTransform('video')
    expect(video).not.toBe(audio)
    expect(h.transforms.map((t) => [t.options.role, t.options.track, t.options.codec])).toEqual([
      ['send', 'audio', 'opus'],
      ['send', 'video', 'vp8']
    ])
    expect(h.workers()).toBe(1)
  })

  it('gives each transform its own port pair: one end to the frame Worker, one to the crypto Worker', async () => {
    const h = harness()
    const e2ee = createVoiceE2ee(h.deps)
    await e2ee.start()
    e2ee.receiverTransform('u-2', 'video')
    await Promise.resolve()
    const [t] = h.transforms
    expect(t?.options).toMatchObject({ role: 'recv', track: 'video', codec: 'vp8', userId: 'u-2' })
    expect(t?.transfer).toEqual([t?.options.port])
    expect((t?.options.port as unknown as { side: string }).side).toBe('frame1')
    expect((h.attached[0] as { side: string }).side).toBe('crypto1')
  })

  it('attaches ports that came before the handle once start resolves', async () => {
    const h = harness()
    const e2ee = createVoiceE2ee(h.deps)
    e2ee.senderTransform('audio')
    expect(h.attached).toHaveLength(0)
    await e2ee.start()
    await Promise.resolve()
    expect(h.attached).toHaveLength(1)
  })

  it('routes ops to the handle and rejects them before start', async () => {
    const h = harness()
    const e2ee = createVoiceE2ee(h.deps)
    const op: VoiceE2eeServerOp = {
      op: 'e2ee_execute_transition',
      d: { transitionId: 1, epoch: 2 }
    }
    await expect(e2ee.handle(op)).rejects.toThrow('not started')
    await e2ee.start()
    await e2ee.handle(op)
    expect(h.log).toContain('handle h-1 e2ee_execute_transition')
  })

  it('stops the call and the Worker on close, once, and makes no transform after', async () => {
    const h = harness()
    const e2ee = createVoiceE2ee(h.deps)
    await e2ee.start()
    e2ee.close()
    e2ee.close()
    expect(h.log.filter((l) => l === 'stop h-1')).toHaveLength(1)
    expect(h.log.filter((l) => l === 'terminate')).toHaveLength(1)
    expect(h.log).toContain('handle-state null')
    expect(() => e2ee.receiverTransform('u-2', 'audio')).toThrow('ended')
  })
})
