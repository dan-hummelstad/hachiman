import { loadPlaywright } from '../pw.mts'
const pw = loadPlaywright()
const kind = process.argv[2] ?? 'chrome'
const b =
  kind === 'firefox'
    ? await pw.firefox.launch({ firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } })
    : kind === 'webkit'
      ? await pw.webkit.launch()
      : await pw.chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const page = await b.newPage()
page.on('console', (m) => console.log('[c]', m.text()))
await page.goto('http://localhost:8280/healthz')
const r = await page.evaluate(async (mode: string) => {
  const src = `let n = {}; onrtctransform = (e) => { const o = e.transformer.options; const k = o.name; n[k] = 0; o.port.onmessage = () => o.port.postMessage(n); e.transformer.readable.pipeThrough(new TransformStream({ transform(f, c) { n[k]++; c.enqueue(f) } })).pipeTo(e.transformer.writable) }`
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  const ch = new MessageChannel()
  const ask = () => new Promise((res) => { ch.port1.onmessage = (e) => res(e.data); ch.port1.postMessage(0) })
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const pc1 = new RTCPeerConnection()
  const pc2 = new RTCPeerConnection()
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate)
  // pc2 offers a recvonly m-line (like the media node), pc1 answers.
  pc2.addTransceiver('audio', { direction: 'recvonly' })
  pc2.ontrack = (e) => {}
  const offer = await pc2.createOffer()
  await pc2.setLocalDescription(offer)
  await pc1.setRemoteDescription(offer)
  const [t] = pc1.getTransceivers()
  const st = new RTCRtpScriptTransform(worker, { name: 'send', port: ch.port2 }, [ch.port2])
  if (mode === 'before' || mode === 'reneg' || mode === 'reassign' || mode === 'latetrack' || mode === 'renegtrack' || mode === 'nulltrack') {
    t.sender.transform = st
    t.direction = 'sendrecv'
    if (mode === 'nulltrack') await t.sender.replaceTrack(null)
    else if (mode !== 'latetrack') await t.sender.replaceTrack(stream.getAudioTracks()[0])
  } else {
    t.direction = 'sendrecv'
    await t.sender.replaceTrack(stream.getAudioTracks()[0])
  }
  const answer = await pc1.createAnswer()
  await pc1.setLocalDescription(answer)
  if (mode !== 'before') t.sender.transform = st
  await pc2.setRemoteDescription(answer)
  await new Promise((r) => setTimeout(r, 1000))
  if (mode === 'latetrack' || mode === 'nulltrack') await t.sender.replaceTrack(stream.getAudioTracks()[0])
  await new Promise((r) => setTimeout(r, 1000))
  const first = await Promise.race([ask(), new Promise((r) => setTimeout(() => r('no answer'), 2000))])
  if (mode === 'reneg' || mode === 'reassign' || mode === 'renegtrack') {
    pc2.addTransceiver('audio', { direction: 'sendonly' })
    const o2 = await pc2.createOffer()
    await pc2.setLocalDescription(o2)
    await pc1.setRemoteDescription(o2)
    if (t.sender.transform !== st) console.log('getter differs')
    if (mode === 'reassign') t.sender.transform = st
    if (mode === 'renegtrack') { t.direction = 'sendrecv'; await t.sender.replaceTrack(stream.getAudioTracks()[0]) }
    const a2 = await pc1.createAnswer()
    await pc1.setLocalDescription(a2)
    await pc2.setRemoteDescription(a2)
  }
  await new Promise((r) => setTimeout(r, 3000))
  let bytes = 0
  ;(await pc1.getStats()).forEach((s) => { if (s.type === 'outbound-rtp') bytes += s.bytesSent })
  return { first, counts: await Promise.race([ask(), new Promise((r) => setTimeout(() => r('no answer'), 2000))]), bytes, hasTransform: !!t.sender.transform }
}, process.argv[3] ?? 'before')
console.log(kind, process.argv[3] ?? 'before', JSON.stringify(r))
await b.close()
