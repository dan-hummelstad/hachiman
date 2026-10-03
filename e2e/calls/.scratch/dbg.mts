import { createGuild, createInvite, joinGuild, joinVoice, launch, sample, signUp, waitSecure } from '../client.mts'
const ka = (process.argv[2] ?? 'chrome') as 'chrome'
const kb = (process.argv[3] ?? 'chrome') as 'chrome'
const a = await launch(ka, 'A')
const b = await launch(kb, 'B')
try {
  await Promise.all([signUp(a, 'Alice'), signUp(b, 'Bob')])
  await createGuild(a, 'Dbg')
  await joinGuild(b, await createInvite(a, 'Dbg'))
  await joinVoice(a)
  await waitSecure(a)
  await joinVoice(b)
  await Promise.all([waitSecure(a), waitSecure(b)])
  await new Promise((r) => setTimeout(r, 8000))
  if (process.env.DBG_OUT === '1') {
    for (const c of [a, b]) console.log('OUT', c.name, JSON.stringify(await c.page.evaluate(async () => { const pc = (window as any).__pcs.at(-1) as RTCPeerConnection; const o: unknown[] = []; (await pc.getStats()).forEach((s: any) => { if (s.type === 'outbound-rtp' || s.type === 'media-source' || s.type === 'codec') o.push({ type: s.type, kind: s.kind, mid: s.mid, ssrc: s.ssrc, bytes: s.bytesSent, mime: s.mimeType, pt: s.payloadType, enc: s.encoderImplementation, active: s.active }) }); const senderStats: unknown[] = []; (await pc.getTransceivers()[0].sender.getStats()).forEach((s: any) => { if (s.type === 'outbound-rtp') senderStats.push({ ssrc: s.ssrc, bytes: s.bytesSent, mid: s.mid }) }); return { o, senderStats } })))
  }
  if (process.env.DBG_SDP) {
    const sdp = await a.page.evaluate(() => ((window as any).__pcs.at(-1) as RTCPeerConnection).remoteDescription!.sdp)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.DBG_SDP, sdp)
  }
  if (process.env.DBG_INPAGE === '1') {
    const r = await a.page.evaluate(async () => {
      const worker = new Worker('/@fs/Users/danielhummelstad/Documents/Projects/hachiman/.claude/worktrees/docs-scope-refresh/pkgs/hachiman-crypto/src/media/transform-worker.ts', { type: 'module' })
      const ch = new MessageChannel()
      let last: unknown = null
      ch.port1.onmessage = (e) => (last = e.data)
      ;(window as any).__keepdbg = ch.port1
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
      t.sender.transform = new RTCRtpScriptTransform(worker, { role: 'send', track: 'audio', codec: 'opus', userId: null, port: ch.port2 }, [ch.port2])
      t.direction = 'sendrecv'
      await t.sender.replaceTrack(stream.getAudioTracks()[0])
      const answer = await pc1.createAnswer()
      await pc1.setLocalDescription(answer)
      await pc2.setRemoteDescription(answer)
      await new Promise((r) => setTimeout(r, 5000))
      return last
    })
    console.log('INPAGE', JSON.stringify(r))
  }
  if (process.env.E2EE_CALLS_NO_PROBE === '1') { await new Promise((r) => setTimeout(r, 4000)); process.exit(0) }
  for (const c of [a, b]) {
    console.log(c.name, JSON.stringify(await sample(c)))
    console.log(c.name, 'frames', JSON.stringify(await c.page.evaluate(() => (window as any).__frames)))
    console.log(c.name, 'same', JSON.stringify(await c.page.evaluate(() => { const w = window as any; return w.__pcs.filter((pc: RTCPeerConnection) => pc.connectionState !== 'closed').flatMap((pc: RTCPeerConnection) => pc.getTransceivers().map((t) => ({ mid: t.mid, s: w.__transforms.indexOf((t.sender as any).transform), r: w.__transforms.indexOf((t.receiver as any).transform), trackState: t.sender.track?.readyState, enabled: t.sender.track?.enabled, label: t.sender.track?.label }))) })))
    console.log(c.name, 'tx', JSON.stringify(await c.page.evaluate(() => (window as any).__pcs.flatMap((pc: RTCPeerConnection) => pc.getTransceivers().map((t) => ({ mid: t.mid, dir: t.direction, cur: t.currentDirection, st: !!(t.sender as any).transform, rt: !!(t.receiver as any).transform, track: t.sender.track?.kind ?? null }))))))
  }
} finally {
  await a.close()
  await b.close()
}
