/**
 * Cross-client E2EE calls (docs/e2ee-plan.md "Verification": each pair of Electron, Chrome,
 * Firefox and Safari; audio, screen share, rejoin, matching codes).
 *
 * For each pair of clients A and B, on a private local stack (stack.mts):
 *   1. Both sign up, set up their first device, A makes a guild and B joins it with an invite.
 *   2. Both join the voice channel. Both locks show "secure".
 *   3. Transforms: every sender and receiver has an RTCRtpScriptTransform, and the transform Worker
 *      counts encrypted frames on the sender and decrypted (tag-verified) frames on the receiver.
 *      There is no plaintext passthrough, so a decrypted frame proves that the SFU carried an
 *      SFrame ciphertext.
 *   4. Audio flows both ways: inbound-rtp audio bytes grow and the receiver decrypts audio frames.
 *   5. Both see the same epoch number and call code, and the same safety number.
 *   6. A shares the screen: B receives and decodes video frames and decrypts them. The codes do
 *      not change.
 *   7. B leaves and joins again: secure again, a new epoch, codes match, audio flows again.
 *
 * Run (the sandbox must allow loopback, docker and the browsers):
 *   node --experimental-strip-types --test e2e/calls/calls.test.mts
 * Env: E2EE_CALLS_CLIENTS=chrome,firefox,webkit,electron (default: all), E2EE_CALLS_PAIRS=chrome-firefox,...
 *      E2EE_CALLS_EXTERNAL_STACK=1 to use a stack that is already up (node e2e/calls/stack.mts).
 *      See README.md for the rest.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import {
  createGuild,
  createInvite,
  joinGuild,
  joinVoice,
  launch,
  leaveVoice,
  readCallCode,
  readSafetyNumber,
  sample,
  signUp,
  startScreenShare,
  stopScreenShare,
  waitSecure,
  type Client,
  type ClientKind,
  type MediaSample
} from './client.mts'
import { launchElectron } from './electron.mts'
import { startStack, type Stack } from './stack.mts'

const ALL: ClientKind[] = ['electron', 'chrome', 'firefox', 'webkit']
const clients = (process.env.E2EE_CALLS_CLIENTS?.split(',').map((s) => s.trim()) ?? ALL) as ClientKind[]
const pairs: [ClientKind, ClientKind][] = process.env.E2EE_CALLS_PAIRS
  ? process.env.E2EE_CALLS_PAIRS.split(',').map((p) => p.trim().split('-') as [ClientKind, ClientKind])
  : clients.flatMap((a, i) => clients.slice(i + 1).map((b) => [a, b] as [ClientKind, ClientKind]))

let stack: Stack | null = null

before(async () => {
  if (process.env.E2EE_CALLS_EXTERNAL_STACK !== '1') stack = await startStack()
}, { timeout: 600_000 })

after(async () => {
  await stack?.stop()
})

/** One step of a pair. A failure ends the pair: the later steps need the earlier ones. */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now()
  try {
    await fn()
  } catch (e) {
    console.log(`  FAIL ${name} (${Date.now() - t0} ms)`)
    throw e
  }
  console.log(`  ok   ${name} (${Date.now() - t0} ms)`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function open(kind: ClientKind, name: string): Promise<Client> {
  return kind === 'electron' ? launchElectron(name) : launch(kind, name)
}

/** Polls until `check(before, now)` passes, or fails with the last reason. */
async function eventually(c: Client, what: string, check: (s0: MediaSample, s: MediaSample) => string | null, timeoutMs = 30_000): Promise<MediaSample> {
  const s0 = await sample(c)
  const deadline = Date.now() + timeoutMs
  let last: MediaSample = s0
  let reason: string | null = 'no sample'
  while (Date.now() < deadline) {
    await sleep(1000)
    last = await sample(c)
    reason = check(s0, last)
    if (reason === null) return last
  }
  assert.fail(`${c.name}: ${what}: ${reason}\nfirst: ${JSON.stringify(s0)}\nlast: ${JSON.stringify(last)}`)
}

const frames = (s: MediaSample, k: string) => s.frames[k] ?? { transforms: 0, encrypted: 0, decrypted: 0, unknownKey: 0, authFailed: 0, replay: 0, wrongSender: 0 }

/** Every sender and receiver is transformed, audio frames are encrypted, sent, received and decrypted. */
function audioFlows(s0: MediaSample, s: MediaSample): string | null {
  if (s.pcs < 1) return 'no peer connection'
  if (!s.senders.kinds.includes('audio')) return 'no audio sender'
  if (s.senders.transformed !== s.senders.withTrack) return `untransformed senders: ${s.senders.transformed}/${s.senders.withTrack}`
  if (s.receivers.transformed !== s.receivers.total) return `untransformed receivers: ${s.receivers.transformed}/${s.receivers.total}`
  if (frames(s, 'send:audio').encrypted <= frames(s0, 'send:audio').encrypted) return 'the sender encrypts no audio frames'
  if (s.outbound.audio.bytes <= s0.outbound.audio.bytes) return 'no outbound audio bytes'
  if (s.inbound.audio.bytes <= s0.inbound.audio.bytes) return 'no inbound audio bytes'
  if (frames(s, 'recv:audio').decrypted <= frames(s0, 'recv:audio').decrypted + 10) return 'the receiver decrypts no audio frames'
  return null
}

function videoFlows(s0: MediaSample, s: MediaSample): string | null {
  if (s.receivers.transformed !== s.receivers.total) return `untransformed receivers: ${s.receivers.transformed}/${s.receivers.total}`
  if (s.inbound.video.bytes <= s0.inbound.video.bytes) return 'no inbound video bytes'
  if (s.inbound.video.framesDecoded <= s0.inbound.video.framesDecoded + 5) return 'no decoded video frames'
  if (frames(s, 'recv:video').decrypted <= frames(s0, 'recv:video').decrypted + 5) return 'the receiver decrypts no video frames'
  return null
}

function videoSent(s0: MediaSample, s: MediaSample): string | null {
  if (!s.senders.kinds.includes('video')) return 'no video sender'
  if (s.senders.transformed !== s.senders.withTrack) return `untransformed senders: ${s.senders.transformed}/${s.senders.withTrack}`
  if (frames(s, 'send:video').encrypted <= frames(s0, 'send:video').encrypted + 5) return 'the sender encrypts no video frames'
  return null
}

async function codesMatch(a: Client, b: Client): Promise<number> {
  // Both sides read the code after the same execute_transition; retry while one side is a step behind.
  for (let i = 0; ; i++) {
    const [ca, cb] = [await readCallCode(a), await readCallCode(b)]
    if (ca.epoch === cb.epoch && ca.code === cb.code) {
      assert.equal(ca.code.length, 30, `${a.name}: the call code has 30 digits`)
      return ca.epoch
    }
    if (i >= 5) assert.fail(`call codes differ: ${a.name} ${JSON.stringify(ca)} vs ${b.name} ${JSON.stringify(cb)}`)
    await sleep(1500)
  }
}

for (const [ka, kb] of pairs) {
  test(`${ka} <-> ${kb}`, { timeout: 900_000 }, async () => {
    const a = await open(ka, `A:${ka}`)
    const b = await open(kb, `B:${kb}`)
    try {
      const nameA = `Alice${ka}`
      const nameB = `Bob${kb}`
      const guild = `Calls ${ka} ${kb}`
      await step('sign up and guild', async () => {
        await Promise.all([signUp(a, nameA), signUp(b, nameB)])
        await createGuild(a, guild)
        await joinGuild(b, await createInvite(a, guild))
      })

      let epoch = -1
      await step('join: secure, transforms, audio both ways', async () => {
        await joinVoice(a)
        await waitSecure(a)
        await joinVoice(b)
        await Promise.all([waitSecure(a), waitSecure(b)])
        await Promise.all([eventually(a, 'audio from B', audioFlows), eventually(b, 'audio from A', audioFlows)])
      })

      await step('epoch code and safety number match', async () => {
        epoch = await codesMatch(a, b)
        assert.ok(epoch >= 1, `epoch after B joined is ${epoch}`)
        const [sa, sb] = [await readSafetyNumber(a, nameB), await readSafetyNumber(b, nameA)]
        assert.equal(sa.length, 60, 'safety number has 60 digits')
        assert.equal(sa, sb, 'both sides show the same safety number')
      })

      await step('screen share: B receives and decrypts video', async () => {
        await startScreenShare(a)
        await Promise.all([eventually(a, 'screen sent', videoSent), eventually(b, 'screen from A', videoFlows, 45_000)])
        const now = await codesMatch(a, b)
        assert.equal(now, epoch, 'a screen share does not change the epoch')
        await stopScreenShare(a)
      })

      await step('rejoin: B leaves and joins again', async () => {
        await leaveVoice(b)
        await sleep(2000)
        await joinVoice(b)
        await Promise.all([waitSecure(a), waitSecure(b)])
        await Promise.all([eventually(a, 'audio from B after rejoin', audioFlows), eventually(b, 'audio from A after rejoin', audioFlows)])
        const next = await codesMatch(a, b)
        assert.ok(next > epoch, `the epoch moves on after leave and join (${epoch} -> ${next})`)
      })
    } finally {
      const tc = Date.now()
      await Promise.all([a.close(), b.close()])
      console.log(`  closed in ${Date.now() - tc} ms`)
    }
  })
}
