import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fakeDelegate,
  FakeMediaStream,
  FakeRTCPeerConnection,
  FakeTrack,
  FakeTransceiver,
  installFakeRtc,
  type FakeDelegate,
} from './test/fake-rtc'
import { FakeWebSocket, installFakeWebSocket } from './test/fake-ws'
import type { VoiceE2eeClientOp, VoiceE2eeServerOp } from './types'
import { VoiceConnection } from './voice'

const flush = () => new Promise<void>(r => setTimeout(r, 0))

const keyPackageOp: VoiceE2eeServerOp = {
  op: 'e2ee_key_package',
  d: { sessionId: 's2', userId: 'bob', deviceId: 'devB', keyPackage: 'KPB' },
}
const commitOp: VoiceE2eeClientOp = {
  op: 'e2ee_commit',
  d: { epoch: 0, commit: 'C', welcome: 'W', added: ['s2'], removed: [] },
}
const treeOp: VoiceE2eeClientOp = { op: 'e2ee_ratchet_tree', d: { epoch: 1, ratchetTree: 'T' } }

describe('VoiceConnection', () => {
  let d: FakeDelegate
  let vc: VoiceConnection
  let ws: FakeWebSocket

  beforeEach(async () => {
    installFakeWebSocket()
    installFakeRtc()
    d = fakeDelegate()
    vc = new VoiceConnection({ endpoint: 'ws://media/voice', token: 'vt', iceServers: [], e2ee: d })
    const connected = vc.connect()
    await flush()
    ws = FakeWebSocket.last
    ws.onopen?.()
    ws.recv({ op: 'ready', d: { sessionId: 's1', ssrc: 7 } })
    await connected
  })

  const pc = () => FakeRTCPeerConnection.last
  const offer = async (sdp = 'offer') => {
    ws.recv({ op: 'offer', d: { sdp } })
    await flush()
  }
  const e2eeSent = () => ws.sent.filter(f => typeof f.op === 'string' && f.op.startsWith('e2ee_'))

  it('identify carries the e2ee key package from the delegate', () => {
    expect(ws.sent[0]).toEqual({ op: 'identify', d: { token: 'vt', e2ee: { version: 1, keyPackage: 'KP' } } })
    expect(vc.sessionId).toBe('s1')
  })

  it('a failed delegate start rejects connect and opens no socket', async () => {
    const d2 = fakeDelegate()
    d2.start = () => Promise.reject(new Error('no identity'))
    const before = FakeWebSocket.instances.length
    const vc2 = new VoiceConnection({ endpoint: 'ws://media/voice', token: 'vt', iceServers: [], e2ee: d2 })
    await expect(vc2.connect()).rejects.toThrow('no identity')
    expect(FakeWebSocket.instances).toHaveLength(before)
    expect(d2.closeCount).toBe(1)
  })

  it('installs one sender transform per track on m-line 0 and 1, and keeps it across renegotiations', async () => {
    await offer()
    const [mic, screen] = pc().transceivers
    expect(d.sendTransforms.map(t => t.track)).toEqual(['audio', 'video'])
    expect(mic?.sender.transform).toBe(d.sendTransforms[0])
    expect(screen?.sender.transform).toBe(d.sendTransforms[1])
    expect(ws.sent.some(f => f.op === 'answer')).toBe(true)

    await offer('renegotiation')
    expect(d.sendTransforms).toHaveLength(2)
    expect(mic?.sender.transform).toBe(d.sendTransforms[0])
    expect(screen?.sender.transform).toBe(d.sendTransforms[1])
  })

  it('setMicrophone, mute and screen start/stop replace tracks and keep the sender transforms', async () => {
    await offer()
    const [mic, screen] = pc().transceivers
    const micTrack = new FakeTrack('audio')
    await vc.setMicrophone(new FakeMediaStream([micTrack]) as unknown as MediaStream)
    expect(mic?.sender.track).toBe(micTrack)
    await vc.setMuted(true)
    expect(mic?.sender.track).toBeNull()

    const screenTrack = new FakeTrack('video') as unknown as MediaStreamTrack
    await vc.setScreen(screenTrack, { maxBitrate: 1, maxFramerate: 30 })
    expect(screen?.sender.track).toBe(screenTrack)
    await vc.setScreen(null)
    expect(screen?.sender.track).toBeNull()

    expect(d.sendTransforms).toHaveLength(2)
    expect(mic?.sender.transform).toBe(d.sendTransforms[0])
    expect(screen?.sender.transform).toBe(d.sendTransforms[1])
  })

  it('a new sender on m-line 0 fails closed instead of making a second transform', async () => {
    await offer()
    const closed = vi.fn()
    vc.on('close', closed)
    const replacement = new FakeTransceiver()
    pc().transceivers[0] = replacement
    await offer('renegotiation')
    expect(d.sendTransforms).toHaveLength(2)
    expect(replacement.sender.transform).toBeNull()
    expect(closed).toHaveBeenCalledWith({ code: 4000, reason: 'renegotiation failed' })
  })

  it('installs a receiver transform on each ontrack with the msid mapping', async () => {
    await offer()
    const audio = pc().fireTrack('bob', 'audio')
    const video = pc().fireTrack('screen-bob', 'video')
    const again = pc().fireTrack('carol', 'audio')
    expect(d.recvTransforms.map(t => [t.userId, t.track])).toEqual([
      ['bob', 'audio'],
      ['bob', 'video'],
      ['carol', 'audio'],
    ])
    expect(audio.receiver.transform).toBe(d.recvTransforms[0])
    expect(video.receiver.transform).toBe(d.recvTransforms[1])
    expect(again.receiver.transform).toBe(d.recvTransforms[2])
  })

  it('releases a receiver transform when its track ends, its peer leaves, the receiver gets a new one, or the call ends', async () => {
    await offer()
    ws.recv({ op: 'peers', d: { peers: [{ userId: 'bob', ssrc: 2 }, { userId: 'carol', ssrc: 3 }] } })
    const audio = pc().fireTrack('bob', 'audio')
    const screen = pc().fireTrack('screen-bob', 'video')
    const carol = pc().fireTrack('carol', 'audio')
    const [bobAudio, bobScreen, carolAudio] = d.recvTransforms
    // The remote screen share stops: its track ends.
    screen.track.onended?.()
    expect(d.released).toEqual([bobScreen])
    // The transceiver is used again: the old transform goes first, and its late `ended` is a no-op.
    pc().fireTrack('dave', 'audio', audio.receiver)
    expect(d.released).toEqual([bobScreen, bobAudio])
    audio.track.onended?.()
    expect(d.released).toHaveLength(2)
    // carol leaves the roster.
    ws.recv({ op: 'peers', d: { peers: [{ userId: 'bob', ssrc: 2 }, { userId: 'dave', ssrc: 4 }] } })
    expect(d.released).toEqual([bobScreen, bobAudio, carolAudio])
    carol.track.onended?.()
    expect(d.released).toHaveLength(3)
    // The call ends: close releases the rest (dave) through the delegate.
    vc.close()
    expect(d.released).toHaveLength(3)
    expect(d.closeCount).toBe(1)
  })

  it('drops tracks without msid or with a kind that does not match the msid', async () => {
    await offer()
    const screens = vi.fn()
    const tracks = vi.fn()
    vc.on('screen', screens)
    vc.on('track', tracks)
    ws.recv({ op: 'peers', d: { peers: [{ userId: 'bob', ssrc: 2 }] } })
    const none = pc().fireTrack(null, 'audio')
    const wrongAudio = pc().fireTrack('screen-bob', 'audio')
    const wrongVideo = pc().fireTrack('bob', 'video')
    expect(d.recvTransforms).toHaveLength(0)
    expect([none, wrongAudio, wrongVideo].map(t => t.receiver.transform)).toEqual([null, null, null])
    expect(screens).not.toHaveBeenCalled()
    expect(tracks).not.toHaveBeenCalled()
  })

  it('routes e2ee ops through the delegate in order and sends the commit, then the ratchet tree', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    d.respond = async op => {
      if (op.op === 'e2ee_key_package') {
        await gate
        return [commitOp, treeOp]
      }
      if (op.op === 'e2ee_prepare_transition')
        return [{ op: 'e2ee_ready', d: { transitionId: 1, epoch: 1, leafIndex: 0 } }]
      return []
    }
    ws.recv(keyPackageOp)
    ws.recv({ op: 'e2ee_prepare_transition', d: { transitionId: 1, epoch: 0, commit: 'C' } })
    await flush()
    expect(d.handled.map(o => o.op)).toEqual(['e2ee_key_package'])
    expect(e2eeSent()).toEqual([])

    release()
    await flush()
    expect(d.handled.map(o => o.op)).toEqual(['e2ee_key_package', 'e2ee_prepare_transition'])
    expect(e2eeSent().map(f => f.op)).toEqual(['e2ee_commit', 'e2ee_ratchet_tree', 'e2ee_ready'])
    expect(e2eeSent()[0]).toEqual(commitOp)
    expect(e2eeSent()[1]).toEqual(treeOp)
  })

  it('a commit with a welcome may get its ratchet tree from the next handle call', async () => {
    d.respond = op => Promise.resolve(op.op === 'e2ee_key_package' ? [commitOp] : [treeOp])
    ws.recv(keyPackageOp)
    ws.recv({ op: 'e2ee_commit_rejected', d: { epoch: 0, currentEpoch: 0 } })
    await flush()
    expect(e2eeSent().map(f => f.op)).toEqual(['e2ee_commit', 'e2ee_ratchet_tree'])
  })

  it('fails closed and sends nothing when the delegate breaks the commit → tree order', async () => {
    const closed = vi.fn()
    vc.on('close', closed)
    d.respond = () =>
      Promise.resolve([commitOp, { op: 'e2ee_ready', d: { transitionId: null, epoch: 0, leafIndex: 0 } }])
    ws.recv(keyPackageOp)
    await flush()
    expect(e2eeSent()).toEqual([])
    expect(closed).toHaveBeenCalledWith({ code: 4000, reason: 'e2ee failure' })
    expect(d.closeCount).toBe(1)
  })

  it('fails closed when the delegate rejects', async () => {
    const closed = vi.fn()
    vc.on('close', closed)
    d.respond = () => Promise.reject(new Error('bad commit'))
    ws.recv({ op: 'e2ee_welcome', d: { transitionId: 1, epoch: 1, welcome: 'W' } })
    await flush()
    expect(closed).toHaveBeenCalledWith({ code: 4000, reason: 'e2ee failure' })
  })

  it('4013 emits resync before close and closes the delegate', () => {
    const events: string[] = []
    vc.on('resync', e => events.push(`resync:${e.code}`))
    vc.on('close', e => events.push(`close:${e.code}`))
    ws.drop(4013, 'e2ee resync')
    expect(events).toEqual(['resync:4013', 'close:4013'])
    expect(d.closeCount).toBe(1)
    expect(pc().closed).toBe(true)
  })

  it.each([4012, 4014])('%i closes without resync', code => {
    const resync = vi.fn()
    const closed = vi.fn()
    vc.on('resync', resync)
    vc.on('close', closed)
    ws.drop(code)
    expect(resync).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledWith({ code, reason: '' })
    expect(d.closeCount).toBe(1)
  })

  it('close() closes the delegate once and ignores later e2ee ops', async () => {
    vc.close()
    vc.close()
    expect(d.closeCount).toBe(1)
    expect(ws.closedWith).toBe(1000)
    ws.recv(keyPackageOp)
    await flush()
    expect(d.handled).toEqual([])
  })
})
