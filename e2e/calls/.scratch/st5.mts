import { readFileSync } from 'node:fs'
import { loadPlaywright } from '../pw.mts'
const pw = loadPlaywright()
const variant = process.argv[2] ?? 'pion'
const pion = readFileSync('/tmp/claude-501/e2ee-calls/pion-offer.sdp', 'utf8')
const b = await pw.chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const page = await b.newPage()
page.on('console', (m) => console.log('[c]', m.text()))
await page.goto('http://localhost:5273/')
const r = await page.evaluate(
  async ({ variant, pion }) => {
    const worker = new Worker('/@fs/Users/danielhummelstad/Documents/Projects/hachiman/.claude/worktrees/docs-scope-refresh/pkgs/hachiman-crypto/src/media/transform-worker.ts', { type: 'module' })
    const ch = new MessageChannel()
    let last: unknown = null
    ch.port1.onmessage = (e) => (last = e.data)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const pc1 = new RTCPeerConnection()
    const pc2 = new RTCPeerConnection()
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {})
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch((err) => console.log('add', err.message))
    pc2.addTransceiver('audio', { direction: 'recvonly' })
    pc2.addTransceiver('video', { direction: 'recvonly' })
    pc2.addTransceiver('audio', { direction: 'sendonly' })
    pc2.addTransceiver('video', { direction: 'sendonly' })
    const o = await pc2.createOffer()
    await pc2.setLocalDescription(o)
    const real = o.sdp!
    const get = (re: RegExp) => re.exec(real)![1]
    const ufrag = get(/a=ice-ufrag:(.*)\r\n/)
    const pwd = get(/a=ice-pwd:(.*)\r\n/)
    const fp = get(/a=fingerprint:(.*)\r\n/)
    let sdp = pion
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => !l.startsWith('a=candidate:'))
      .map((l) => (l.startsWith('a=ice-ufrag:') ? 'a=ice-ufrag:' + ufrag : l.startsWith('a=ice-pwd:') ? 'a=ice-pwd:' + pwd : l.startsWith('a=fingerprint:') ? 'a=fingerprint:' + fp : l))
      .filter((l) => l.length > 0)
      .join('\r\n') + '\r\n'
    if (variant === 'chrome') sdp = real
    await pc1.setRemoteDescription({ type: 'offer', sdp })
    const [t, tv] = pc1.getTransceivers()
    t.sender.transform = new RTCRtpScriptTransform(worker, { role: 'send', track: 'audio', codec: 'opus', userId: null, port: ch.port2 }, [ch.port2])
    t.direction = 'sendrecv'
    if (tv) tv.direction = 'sendrecv'
    await t.sender.replaceTrack(stream.getAudioTracks()[0])
    const answer = await pc1.createAnswer()
    await pc1.setLocalDescription(answer)
    await pc2.setRemoteDescription(answer).catch((e) => console.log('pc2 srd', e.message))
    await new Promise((r) => setTimeout(r, 6000))
    let bytes = 0
    ;(await pc1.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'audio') bytes += s.bytesSent
    })
    return { last, bytes, conn: pc1.connectionState }
  },
  { variant, pion }
)
console.log(variant, JSON.stringify(r))
await b.close()
