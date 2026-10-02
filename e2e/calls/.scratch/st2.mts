import { loadPlaywright } from '../pw.mts'
import { probe } from '../probe.ts'
const pw = loadPlaywright()
const kind = process.argv[2] ?? 'chrome'
const withProbe = process.argv[3] === 'probe'
const b =
  kind === 'firefox'
    ? await pw.firefox.launch({ firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } })
    : kind === 'webkit'
      ? await pw.webkit.launch()
      : await pw.chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const ctx = await b.newContext()
if (withProbe) await ctx.addInitScript(probe, { fakeMic: kind === 'webkit' })
const page = await ctx.newPage()
page.on('console', (m) => console.log('[c]', m.text()))
await page.goto('http://localhost:5273/')
const r = await page.evaluate(async () => {
  const worker = new Worker('/@fs/Users/danielhummelstad/Documents/Projects/hachiman/.claude/worktrees/docs-scope-refresh/pkgs/hachiman-crypto/src/media/transform-worker.ts', { type: 'module' })
  const ch = new MessageChannel()
  let last: unknown = null
  ch.port1.onmessage = (e) => (last = e.data)
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const pc1 = new RTCPeerConnection()
  const pc2 = new RTCPeerConnection()
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate)
  pc2.addTransceiver('audio', { direction: 'recvonly' })
  const offer = await pc2.createOffer()
  await pc2.setLocalDescription(offer)
  await pc1.setRemoteDescription(offer)
  const [t] = pc1.getTransceivers()
  const st = new RTCRtpScriptTransform(worker, { role: 'send', track: 'audio', codec: 'opus', userId: null, port: ch.port2 }, [ch.port2])
  t.sender.transform = st
  t.direction = 'sendrecv'
  await t.sender.replaceTrack(stream.getAudioTracks()[0])
  const answer = await pc1.createAnswer()
  await pc1.setLocalDescription(answer)
  await pc2.setRemoteDescription(answer)
  await new Promise((r) => setTimeout(r, 5000))
  let bytes = 0
  ;(await pc1.getStats()).forEach((s) => {
    if (s.type === 'outbound-rtp') bytes += s.bytesSent
  })
  return { last, bytes, frames: (window as any).__frames ?? null }
})
console.log(kind, withProbe, JSON.stringify(r))
await b.close()
