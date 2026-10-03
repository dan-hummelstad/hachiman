import { loadPlaywright } from '../pw.mts'
const pw = loadPlaywright()
const variant = process.argv[2] ?? 'full'
const b = await pw.chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const page = await b.newPage()
page.on('console', (m) => console.log('[c]', m.text()))
await page.goto('http://localhost:5273/')
const r = await page.evaluate(async (variant: string) => {
  const worker = new Worker('/@fs/Users/danielhummelstad/Documents/Projects/hachiman/.claude/worktrees/docs-scope-refresh/pkgs/hachiman-crypto/src/media/transform-worker.ts', { type: 'module' })
  const stats: Record<string, unknown> = {}
  const mk = (name: string, o: Record<string, unknown>) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = (e) => (stats[name] = e.data)
    ;(window as any)['keep' + name] = ch.port1
    return new RTCRtpScriptTransform(worker, { ...o, port: ch.port2 }, [ch.port2])
  }
  const cfg = variant.includes('stun') ? { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] } : {}
  const pc1 = new RTCPeerConnection(cfg)
  const pc2 = new RTCPeerConnection(cfg)
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
  const buffered: RTCIceCandidate[] = []
  let flowing = !variant.includes('cands')
  pc2.onicecandidate = (e) => { if (!e.candidate) return; if (flowing) pc1.addIceCandidate(e.candidate); else buffered.push(e.candidate) }
  pc2.addTransceiver('audio', { direction: 'recvonly' })
  pc2.addTransceiver('video', { direction: 'recvonly' })
  if (variant.includes('recv')) {
    pc1.ontrack = (e) => {
      ;(e.receiver as any).transform = mk('r' + e.track.kind, { role: 'recv', track: e.track.kind, codec: e.track.kind === 'audio' ? 'opus' : 'vp8', userId: 'u1' })
    }
  }
  if (variant.includes('opus')) {
    const [ta, tv] = pc2.getTransceivers()
    ta.setCodecPreferences(RTCRtpReceiver.getCapabilities('audio')!.codecs.filter((c) => c.mimeType === 'audio/opus'))
    tv.setCodecPreferences(RTCRtpReceiver.getCapabilities('video')!.codecs.filter((c) => c.mimeType === 'video/VP8'))
  }
  const offer = await pc2.createOffer()
  await pc2.setLocalDescription(offer)
  let osdp = offer.sdp!
  if (variant.includes('noext')) osdp = osdp.split('\r\n').filter((l) => !l.startsWith('a=extmap:') || l.includes('transport-wide-cc')).join('\r\n')
  await pc1.setRemoteDescription({ type: 'offer', sdp: osdp })
  if (!flowing && !variant.includes('after')) {
    await new Promise((r) => setTimeout(r, 500))
    for (const c of buffered) await pc1.addIceCandidate(c)
    flowing = true
  }
  if (variant.includes('delay')) await new Promise((r) => setTimeout(r, 500))
  const [mic, screen] = pc1.getTransceivers()
  mic.sender.transform = mk('sa', { role: 'send', track: 'audio', codec: 'opus', userId: null })
  mic.direction = 'sendrecv'
  await mic.sender.replaceTrack(null)
  screen.sender.transform = mk('sv', { role: 'send', track: 'video', codec: 'vp8', userId: null })
  screen.direction = 'sendrecv'
  if (!flowing) {
    await new Promise((r) => setTimeout(r, 500))
    for (const c of buffered) await pc1.addIceCandidate(c)
    flowing = true
  }
  const early = variant.startsWith('race') ? await navigator.mediaDevices.getUserMedia({ audio: true }) : null
  if (variant === 'race-before-answer') void mic.sender.replaceTrack(early!.getAudioTracks()[0])
  const answer = await pc1.createAnswer()
  if (variant === 'race-before-sld') void mic.sender.replaceTrack(early!.getAudioTracks()[0])
  const sld = pc1.setLocalDescription(answer)
  if (variant === 'race-during-sld') void mic.sender.replaceTrack(early!.getAudioTracks()[0])
  await sld
  await screen.sender.replaceTrack(null)
  if (variant !== 'noparams') {
    const params = screen.sender.getParameters()
    if (params.encodings[0]) await screen.sender.setParameters(params).catch((e) => console.log('setParameters', e.message))
  }
  await pc2.setRemoteDescription(answer)
  if (variant.includes('quickreneg')) {
    const s2 = await navigator.mediaDevices.getUserMedia({ audio: true })
    pc2.addTransceiver(s2.getAudioTracks()[0], { direction: 'sendonly', streams: [s2] })
    pc2.addTransceiver('video', { direction: 'sendonly' })
    const o2 = await pc2.createOffer()
    await pc2.setLocalDescription(o2)
    await pc1.setRemoteDescription(o2)
    const a2 = await pc1.createAnswer()
    await pc1.setLocalDescription(a2)
    await pc2.setRemoteDescription(a2)
  }
  await new Promise((r) => setTimeout(r, 1500))
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  if (variant !== 'novad') {
    const ctx = new AudioContext()
    ctx.createMediaStreamSource(stream).connect(ctx.createAnalyser())
  }
  if (!variant.startsWith('race')) await mic.sender.replaceTrack(stream.getAudioTracks()[0])
  await new Promise((r) => setTimeout(r, 4500))
  let bytes = 0
  ;(await pc1.getStats()).forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'audio') bytes += s.bytesSent
  })
  return { stats, bytes }
}, variant)
console.log(variant, JSON.stringify(r))
await b.close()
