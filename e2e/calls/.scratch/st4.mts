import { readFileSync } from 'node:fs'
import { loadPlaywright } from '../pw.mts'
const pw = loadPlaywright()
const variant = process.argv[2] ?? 'pion'
const pion = readFileSync('/tmp/claude-501/e2ee-calls/pion-offer.sdp', 'utf8')
const b = await pw.chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const page = await b.newPage()
await page.goto('http://localhost:5273/')
const r = await page.evaluate(
  async ({ variant, pion }) => {
    const worker = new Worker('/@fs/Users/danielhummelstad/Documents/Projects/hachiman/.claude/worktrees/docs-scope-refresh/pkgs/hachiman-crypto/src/media/transform-worker.ts', { type: 'module' })
    const ch = new MessageChannel()
    let last: unknown = null
    ch.port1.onmessage = (e) => (last = e.data)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const pc1 = new RTCPeerConnection()
    let sdp = pion
    if (variant === 'chrome') {
      const pc2 = new RTCPeerConnection()
      pc2.addTransceiver('audio', { direction: 'recvonly' })
      pc2.addTransceiver('video', { direction: 'recvonly' })
      const o = await pc2.createOffer()
      sdp = o.sdp!
    }
    if (variant === 'pion-trickle') sdp = sdp.replace(/a=ice-ufrag/g, 'a=ice-options:trickle\r\na=ice-ufrag')
    await pc1.setRemoteDescription({ type: 'offer', sdp })
    const [t] = pc1.getTransceivers()
    t.sender.transform = new RTCRtpScriptTransform(worker, { role: 'send', track: 'audio', codec: 'opus', userId: null, port: ch.port2 }, [ch.port2])
    t.direction = 'sendrecv'
    await t.sender.replaceTrack(stream.getAudioTracks()[0])
    const answer = await pc1.createAnswer()
    await pc1.setLocalDescription(answer)
    await new Promise((r) => setTimeout(r, 6000))
    return { last, ice: pc1.iceConnectionState, conn: pc1.connectionState }
  },
  { variant, pion }
)
console.log(variant, JSON.stringify(r))
await b.close()
