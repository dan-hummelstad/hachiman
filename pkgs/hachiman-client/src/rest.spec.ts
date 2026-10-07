import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRetryAfter, RestClient, RestError } from './rest'
import type { CommitRequest, DeviceProofRequest } from './types'

// Hand-rolled XMLHttpRequest fake for the node test env (no jsdom).
class FakeXHR {
  static last: FakeXHR | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}
  responseHeaders: Record<string, string> = {}
  body: unknown = undefined
  status = 0
  responseText = ''
  aborted = false
  upload: {
    onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null
  } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXHR.last = this
  }
  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v
  }
  getResponseHeader(k: string): string | null {
    return this.responseHeaders[k] ?? null
  }
  send(body: unknown): void {
    this.body = body
  }
  abort(): void {
    this.aborted = true
    this.onabort?.()
  }
  respond(status: number, body: string, headers: Record<string, string> = {}): void {
    this.status = status
    this.responseText = body
    this.responseHeaders = headers
    this.onload?.()
  }
}

const sent = async (): Promise<FakeXHR> => {
  await vi.waitFor(() => {
    expect(FakeXHR.last?.body).toBeDefined()
  })
  return FakeXHR.last!
}

let deviceId: string | null = 'dev1'
const rest = new RestClient({
  baseUrl: 'http://api/v1/',
  getToken: () => Promise.resolve('tok'),
  getDeviceId: () => deviceId,
})

describe('RestClient files', () => {
  beforeEach(() => {
    FakeXHR.last = null
    deviceId = 'dev1'
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fileUrl encodes each path segment', () => {
    expect(rest.fileUrl('abc/my file#1?.png')).toBe('http://api/v1/files/abc/my%20file%231%3F.png')
    expect(rest.fileUrl('u1/blob')).toBe('http://api/v1/files/u1/blob')
  })

  it('uploadBlob posts ?kind=blob as octet-stream with auth and device, reports progress, resolves the Attachment', async () => {
    const onProgress = vi.fn()
    const blob = new Blob(['ciphertext'], { type: 'image/png' })
    const p = rest.uploadBlob(blob, { onProgress })
    const xhr = await sent()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('http://api/v1/uploads?kind=blob')
    expect(xhr.headers['Authorization']).toBe('Bearer tok')
    expect(xhr.headers['X-Hachiman-Device']).toBe('dev1')
    // The real type is in the envelope only: the request never names it.
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream')
    expect(xhr.body).toBe(blob)
    xhr.upload.onprogress?.({ loaded: 2, total: 10, lengthComputable: true })
    xhr.upload.onprogress?.({ loaded: 3, total: 0, lengthComputable: false })
    expect(onProgress.mock.calls).toEqual([
      [2, 10],
      [3, 10],
    ])
    const att = { id: 'u', key: 'u/blob', size: 10 }
    xhr.respond(201, JSON.stringify(att))
    await expect(p).resolves.toEqual(att)
  })

  it('uploadSnapshot posts ?kind=page_snapshot as octet-stream', async () => {
    const p = rest.uploadSnapshot(new Blob(['x']))
    const xhr = await sent()
    expect(xhr.url).toBe('http://api/v1/uploads?kind=page_snapshot')
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream')
    xhr.respond(201, JSON.stringify({ id: 'u1', key: 'u1/blob', size: 1 }))
    await expect(p).resolves.toEqual({ id: 'u1', key: 'u1/blob', size: 1 })
  })

  it('uploadImage posts ?filename= with the image type', async () => {
    const file = new Blob(['png'], { type: 'image/png' })
    const p = rest.uploadImage(file, { filename: 'a b.png' })
    const xhr = await sent()
    expect(xhr.url).toBe('http://api/v1/uploads?filename=a+b.png')
    expect(xhr.headers['Content-Type']).toBe('image/png')
    xhr.respond(201, JSON.stringify({ id: 'u', key: 'u/a_b.png', size: 3 }))
    await expect(p).resolves.toEqual({ id: 'u', key: 'u/a_b.png', size: 3 })
  })

  it('uploadImage defaults Content-Type to application/octet-stream; no device ⇒ no device header', async () => {
    deviceId = null
    void rest.uploadImage(new Blob(['x']), { filename: 'x' }).catch(() => undefined)
    const xhr = await sent()
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream')
    expect(xhr.headers).not.toHaveProperty('X-Hachiman-Device')
  })

  it('an upload maps a 413 to RestError like the fetch path, with Retry-After', async () => {
    const p = rest.uploadBlob(new Blob(['x']))
    ;(await sent()).respond(429, JSON.stringify({ error: 'RateLimited', message: 'slow down' }), {
      'Retry-After': '7',
    })
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RestError)
    expect(err).toMatchObject({ status: 429, code: 'RateLimited', message: 'slow down', retryAfterSec: 7 })
  })

  it('an upload maps a non-JSON error body to HTTP_<status>', async () => {
    const p = rest.uploadBlob(new Blob(['x']))
    ;(await sent()).respond(413, '<html>nginx</html>')
    await expect(p).rejects.toMatchObject({ status: 413, code: 'HTTP_413', retryAfterSec: null })
  })

  it('aborting the signal aborts the XHR and rejects with AbortError', async () => {
    const ac = new AbortController()
    const p = rest.uploadBlob(new Blob(['x']), { signal: ac.signal })
    const xhr = await sent()
    ac.abort()
    expect(xhr.aborted).toBe(true)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('an already-aborted signal rejects without opening a request', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(rest.uploadBlob(new Blob(['x']), { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(FakeXHR.last).toBeNull()
  })
})

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

describe('RestClient fetch routes', () => {
  let calls: Call[]
  let reply: () => Response

  beforeEach(() => {
    calls = []
    deviceId = 'dev1'
    reply = () => new Response('{}', { status: 200 })
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return Promise.resolve(reply())
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const json =
    (status: number, body: unknown, headers: Record<string, string> = {}) =>
    () =>
      new Response(JSON.stringify(body), { status, headers })
  const last = (): Call => {
    const c = calls.at(-1)
    if (!c) throw new Error('no call')
    return c
  }

  it('createThread POSTs to the parent; listThreads GETs its threads', async () => {
    await rest.createThread('c1', { name: 'Bracket', startMessageId: 'm1' })
    expect(last()).toMatchObject({ method: 'POST', url: 'http://api/v1/channels/c1/threads', body: { name: 'Bracket', startMessageId: 'm1' } })
    reply = json(200, [])
    await expect(rest.listThreads('c1')).resolves.toEqual([])
    expect(last()).toMatchObject({ method: 'GET', url: 'http://api/v1/channels/c1/threads' })
  })

  it('sends Authorization and X-Hachiman-Device on every authed request', async () => {
    await rest.getMe()
    expect(last().headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Hachiman-Device': 'dev1' })
    deviceId = null
    await rest.getMe()
    expect(last().headers).not.toHaveProperty('X-Hachiman-Device')
  })

  it('signs each device request and POST /devices with the prover (§12.12 device proof)', async () => {
    const seen: DeviceProofRequest[] = []
    const proved = new RestClient({
      baseUrl: 'http://api/v1/',
      getToken: () => Promise.resolve('tok'),
      getDeviceId: () => deviceId,
      proveDevice: (r) => {
        seen.push(r)
        return Promise.resolve({ ts: 42, nonce: 'n'.repeat(22), sig: 'sig' })
      },
    })
    await proved.getInbox({ after: 3 })
    expect(last().headers).toMatchObject({
      'X-Hachiman-Device': 'dev1',
      'X-Hachiman-Device-Ts': '42',
      'X-Hachiman-Device-Nonce': 'n'.repeat(22),
      'X-Hachiman-Device-Sig': 'sig',
    })
    const sha = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
    expect(seen[0]).toEqual({ kind: 'ds', method: 'GET', pathAndQuery: '/v1/devices/@me/inbox?after=3', bodySha256: await sha('') })

    deviceId = null
    const body = { name: 'n', platform: 'browser' as const, clientVersion: '1.0.0', mlsSignatureKey: 'k' }
    await proved.registerDevice(body)
    expect(last().headers).not.toHaveProperty('X-Hachiman-Device')
    expect(last().headers['X-Hachiman-Device-Sig']).toBe('sig')
    expect(seen[1]).toEqual({ kind: 'ds', method: 'POST', pathAndQuery: '/v1/devices', bodySha256: await sha(JSON.stringify(body)) })
    // No device, not POST /devices: no proof.
    await proved.getMe()
    expect(seen).toHaveLength(2)
    expect(last().headers).not.toHaveProperty('X-Hachiman-Device-Sig')
  })

  it('a public route sends neither token nor device', async () => {
    await rest.previewInvite('abc')
    expect(last().headers).not.toHaveProperty('Authorization')
    expect(last().headers).not.toHaveProperty('X-Hachiman-Device')
  })

  it('createInvite sends maxAgeSeconds 0 and acknowledgedPermanent as given', async () => {
    await rest.createInvite('g1', { maxAgeSeconds: 0, maxUses: 5, acknowledgedPermanent: true })
    expect(last()).toMatchObject({
      url: 'http://api/v1/guilds/g1/invites',
      method: 'POST',
      body: { maxAgeSeconds: 0, maxUses: 5, acknowledgedPermanent: true },
    })
    await rest.createInvite('g1', { maxAgeSeconds: 3600 })
    expect(last().body).toEqual({ maxAgeSeconds: 3600 })
    await rest.createInvite('g1', { maxAgeSeconds: 3600, maxUses: 1, record: 'UkVD' })
    expect(last().body).toEqual({ maxAgeSeconds: 3600, maxUses: 1, record: 'UkVD' })
  })

  it('the invite history routes use the §12.12 paths and bodies', async () => {
    await rest.inviteRecords('g1')
    expect(last()).toMatchObject({ url: 'http://api/v1/guilds/g1/invite-records', method: 'GET' })
    await rest.postInviteBundle('i1', { groupId: 'R1', epoch: 4, blob: 'QkxC' })
    expect(last()).toMatchObject({
      url: 'http://api/v1/invite-records/i1/bundles',
      method: 'POST',
      body: { groupId: 'R1', epoch: 4, blob: 'QkxC' },
    })
    await rest.inviteBundles('ABCD2345')
    expect(last()).toMatchObject({ url: 'http://api/v1/invites/ABCD2345/bundles', method: 'GET' })
    expect(last().headers['Authorization']).toBe('Bearer tok')
  })

  it('the pin, guild event, RSVP, block and role hoist routes use the §4 paths and bodies', async () => {
    const expectCall = async (p: Promise<unknown>, method: string, path: string, body?: unknown) => {
      await p
      expect(last()).toMatchObject({ url: `http://api/v1${path}`, method })
      expect(last().body).toEqual(body)
    }
    await expectCall(rest.getPins('c1'), 'GET', '/channels/c1/pins')
    await expectCall(rest.pinMessage('c1', 'm1'), 'PUT', '/channels/c1/pins/m1')
    await expectCall(rest.unpinMessage('c1', 'm1'), 'DELETE', '/channels/c1/pins/m1')
    await expectCall(rest.getGuildEvents('g1'), 'GET', '/guilds/g1/events')
    const ev = { title: 'Scrims', startsAt: '2026-10-08T21:00:00.000Z', channelId: 'v1' }
    await expectCall(rest.createGuildEvent('g1', ev), 'POST', '/guilds/g1/events', ev)
    await expectCall(rest.updateGuildEvent('e1', { endsAt: null }), 'PATCH', '/events/e1', { endsAt: null })
    await expectCall(rest.deleteGuildEvent('e1'), 'DELETE', '/events/e1')
    await expectCall(rest.setEventRsvp('e1', true), 'PUT', '/events/e1/rsvp')
    await expectCall(rest.setEventRsvp('e1', false), 'DELETE', '/events/e1/rsvp')
    await expectCall(rest.getBlocks(), 'GET', '/users/@me/blocks')
    await expectCall(rest.blockUser('u2'), 'PUT', '/users/@me/blocks/u2')
    await expectCall(rest.unblockUser('u2'), 'DELETE', '/users/@me/blocks/u2')
    await expectCall(rest.updateRole('g1', 'r1', { hoist: true }), 'PATCH', '/guilds/g1/roles/r1', { hoist: true })
    expect(last().headers['X-Hachiman-Signed-Action']).toBeUndefined()
  })

  it('the page routes use the §4 Pages paths and bodies', async () => {
    await rest.getPages('c1')
    expect(last()).toMatchObject({ url: 'http://api/v1/channels/c1/pages', method: 'GET' })
    await rest.getPageHeads('c1')
    expect(last()).toMatchObject({ url: 'http://api/v1/channels/c1/pages/heads', method: 'GET' })
    await rest.createPage('c1', { id: 'p1', parentId: null, position: 0, titleEnvelope: 'T' })
    expect(last()).toMatchObject({
      url: 'http://api/v1/channels/c1/pages',
      method: 'POST',
      body: { id: 'p1', parentId: null, position: 0, titleEnvelope: 'T' },
    })
    await rest.updatePage('p1', { parentId: 'p0' })
    expect(last()).toMatchObject({ url: 'http://api/v1/pages/p1', method: 'PATCH', body: { parentId: 'p0' } })
    await rest.updatePage('p1', { titleEnvelope: 'T2', ifUpdatedAt: '2026-10-06T10:00:00.000Z' })
    expect(last()).toMatchObject({ method: 'PATCH', body: { titleEnvelope: 'T2', ifUpdatedAt: '2026-10-06T10:00:00.000Z' } })
    await rest.getPageState('p1')
    expect(last()).toMatchObject({ url: 'http://api/v1/pages/p1/state', method: 'GET' })
    await rest.getPageUpdates('p1', { after: 7, limit: 50 })
    expect(last()).toMatchObject({ url: 'http://api/v1/pages/p1/updates?after=7&limit=50', method: 'GET' })
    await rest.postPageUpdate('p1', { envelope: 'U' })
    expect(last()).toMatchObject({ url: 'http://api/v1/pages/p1/updates', method: 'POST', body: { envelope: 'U' } })
    await rest.postPageSnapshot('p1', { baseSeq: 9, uploadId: 'u1', envelope: 'S', mediaUploadIds: ['m1'] })
    expect(last()).toMatchObject({
      url: 'http://api/v1/pages/p1/snapshots',
      method: 'POST',
      body: { baseSeq: 9, uploadId: 'u1', envelope: 'S', mediaUploadIds: ['m1'] },
    })
    await rest.claimPageMedia('p1', ['m1'])
    expect(last()).toMatchObject({ url: 'http://api/v1/pages/p1/media', method: 'POST', body: { uploadIds: ['m1'] } })
    await rest.deletePage('p1')
    expect(last()).toMatchObject({ url: 'http://api/v1/pages/p1', method: 'DELETE' })
  })

  it('a snapshot CAS loss rejects with SnapshotConflict and the current baseSeq', async () => {
    reply = json(409, { error: 'SnapshotConflict', baseSeq: 12 })
    await expect(
      rest.postPageSnapshot('p1', { baseSeq: 9, uploadId: 'u1', envelope: 'S', mediaUploadIds: [] }),
    ).rejects.toMatchObject({ status: 409, code: 'SnapshotConflict', details: { baseSeq: 12 } })
  })

  it('ackMessage posts the message id', async () => {
    await rest.ackMessage('c1', 'm1')
    expect(last()).toMatchObject({ url: 'http://api/v1/channels/c1/ack', method: 'POST', body: { messageId: 'm1' } })
  })

  it('sendMessage and editMessage send the envelope', async () => {
    await rest.sendMessage('c1', { envelope: 'SAE', nonce: 'n', attachments: ['f1', 't1'] })
    expect(last()).toMatchObject({
      url: 'http://api/v1/channels/c1/messages',
      method: 'POST',
      body: { envelope: 'SAE', nonce: 'n', attachments: ['f1', 't1'] },
    })
    await rest.editMessage('c1', 'm1', { envelope: 'SAF' })
    expect(last()).toMatchObject({
      url: 'http://api/v1/channels/c1/messages/m1',
      method: 'PATCH',
      body: { envelope: 'SAF' },
    })
  })

  it.each([
    [
      'registerDevice',
      () => rest.registerDevice({ name: 'n', platform: 'browser', clientVersion: '1.0.0', mlsSignatureKey: 'k' }),
      'POST',
      '/devices',
    ],
    ['listDevices', () => rest.listDevices(), 'GET', '/devices'],
    ['renameDevice', () => rest.renameDevice('d1', 'x'), 'PATCH', '/devices/d1'],
    [
      'putDeviceCertificate',
      () => rest.putDeviceCertificate('d1', { certificate: 'c' }),
      'PUT',
      '/devices/d1/certificate',
    ],
    [
      'revokeDevice',
      () => rest.revokeDevice('d1', { revocation: null, reason: 'signed_out' }),
      'POST',
      '/devices/d1/revoke',
    ],
    ['getUserKeys', () => rest.getUserKeys('u1'), 'GET', '/users/u1/keys'],
    ['putMasterKey', () => rest.putMasterKey({ record: 'r', dskCert: 'c' }), 'PUT', '/users/@me/master-key'],
    [
      'putDeviceSigningKey',
      () => rest.putDeviceSigningKey({ cert: 'c' }),
      'PUT',
      '/users/@me/device-signing-key',
    ],
    ['getDsInfo', () => rest.getDsInfo(), 'GET', '/mls/ds'],
    [
      'uploadKeyPackages',
      () => rest.uploadKeyPackages({ cipherSuite: 1, keyPackages: [], lastResort: null }),
      'POST',
      '/mls/key-packages',
    ],
    ['countKeyPackages', () => rest.countKeyPackages(), 'GET', '/mls/key-packages/count'],
    ['listMlsGroups', () => rest.listMlsGroups(), 'GET', '/mls/groups'],
    ['getMlsGroup', () => rest.getMlsGroup('AQ-_'), 'GET', '/mls/groups/AQ-_'],
    ['getMlsGroupState', () => rest.getMlsGroupState('g1'), 'GET', '/mls/groups/g1/state'],
    ['getMlsGroupState epoch', () => rest.getMlsGroupState('g1', 4), 'GET', '/mls/groups/g1/state?epoch=4'],
    [
      'getHandshakes',
      () => rest.getHandshakes('g1', { after: 10, limit: 50 }),
      'GET',
      '/mls/groups/g1/handshakes?after=10&limit=50',
    ],
    [
      'postJoinRequest',
      () => rest.postJoinRequest('g1', { keyPackage: 'kp' }),
      'POST',
      '/mls/groups/g1/join-requests',
    ],
    ['getJoinRequest', () => rest.getJoinRequest('j1'), 'GET', '/mls/join-requests/j1'],
    ['declineBatch', () => rest.declineBatch('b1', 'busy'), 'POST', '/mls/batches/b1/decline'],
    [
      'postHistoryBundle',
      () => rest.postHistoryBundle('g1', { epoch: 2, blob: 'b' }),
      'POST',
      '/mls/groups/g1/history-bundles',
    ],
    [
      'getHistoryBundles',
      () => rest.getHistoryBundles('g1', 2),
      'GET',
      '/mls/groups/g1/history-bundles?epoch=2',
    ],
    ['getInbox', () => rest.getInbox({ after: 0 }), 'GET', '/devices/@me/inbox?after=0'],
    ['ackInbox', () => rest.ackInbox('i1'), 'DELETE', '/devices/@me/inbox/i1'],
    [
      'postInbox',
      () => rest.postInbox('d2', { kind: 'history_keys', body: 'b' }),
      'POST',
      '/devices/d2/inbox',
    ],
    ['getBackups', () => rest.getBackups(), 'GET', '/backups'],
    [
      'putIdentityBackup',
      () => rest.putIdentityBackup({ keyId: 'k', blob: 'b' }),
      'PUT',
      '/backups/identity',
    ],
    [
      'postHistoryBackup',
      () => rest.postHistoryBackup({ keyId: 'k', groupId: 'g', epochFrom: 0, epochTo: 3, blob: 'b' }),
      'POST',
      '/backups/history',
    ],
    ['getBackup', () => rest.getBackup('x'), 'GET', '/backups/x'],
    ['deleteBackups', () => rest.deleteBackups(), 'DELETE', '/backups'],
    ['createLinkSession', () => rest.createLinkSession({ offer: 'o' }), 'POST', '/devices/link-sessions'],
    ['listLinkSessions', () => rest.listLinkSessions(), 'GET', '/devices/link-sessions'],
    [
      'postLinkMessage',
      () => rest.postLinkMessage('l1', { body: 'b' }),
      'POST',
      '/devices/link-sessions/l1/messages',
    ],
    [
      'getLinkMessages',
      () => rest.getLinkMessages('l1', 3),
      'GET',
      '/devices/link-sessions/l1/messages?after=3',
    ],
    ['deleteLinkSession', () => rest.deleteLinkSession('l1'), 'DELETE', '/devices/link-sessions/l1'],
    ['ktTreeHead', () => rest.ktTreeHead(), 'GET', '/kt/tree-head'],
    ['ktInclusion', () => rest.ktInclusion(5, 9), 'GET', '/kt/inclusion?index=5&treeSize=9'],
    ['ktConsistency', () => rest.ktConsistency(4, 9), 'GET', '/kt/consistency?from=4&to=9'],
    [
      'ktEntries user',
      () => rest.ktEntries({ userId: 'u1', after: 2 }),
      'GET',
      '/kt/entries?userId=u1&after=2',
    ],
    ['ktEntries range', () => rest.ktEntries({ start: 0, end: 1000 }), 'GET', '/kt/entries?start=0&end=1000'],
    ['getAdminActions', () => rest.getAdminActions('gu', 7), 'GET', '/guilds/gu/admin-actions?after=7'],
    [
      'report',
      () => rest.report({ messageId: 'm', content: 'c', frankingKey: 'k', reason: 'spam' }),
      'POST',
      '/reports',
    ],
    [
      'createMlsGroup',
      () =>
        rest.createMlsGroup({
          groupId: 'g',
          kind: 'dm',
          guildId: null,
          channelId: 'c',
          cipherSuite: 1,
          groupInfo: 'i',
          ratchetTree: 't',
          assignmentId: null,
        }),
      'POST',
      '/mls/groups',
    ],
  ] as const)('%s → %s %s', async (_name, call, method, path) => {
    await call()
    expect(last().method).toBe(method)
    expect(last().url).toBe(`http://api/v1${path}`)
    expect(last().headers['X-Hachiman-Device']).toBe('dev1')
  })

  it('a 201 or 204 without a body resolves undefined', async () => {
    reply = () => new Response('', { status: 201 })
    await expect(rest.postHistoryBundle('g1', { epoch: 1, blob: 'b' })).resolves.toBeUndefined()
    reply = () => new Response(null, { status: 204 })
    await expect(rest.ackInbox('i1')).resolves.toBeUndefined()
  })

  describe('postCommit', () => {
    const body: CommitRequest = {
      epoch: 4,
      commit: 'c',
      groupInfo: 'gi',
      ratchetTree: 'rt',
      welcome: null,
      batchId: 'b1',
      rejected: [{ pendingId: 'p1', reason: 'invalid_chain' }],
    }

    it('201 resolves ok with epoch and seq', async () => {
      reply = json(201, { epoch: 5, seq: 77 })
      await expect(rest.postCommit('g1', body)).resolves.toEqual({ ok: true, epoch: 5, seq: 77 })
      expect(last()).toMatchObject({ url: 'http://api/v1/mls/groups/g1/commits', method: 'POST', body })
    })

    it('sends proposalRef rejections as rejectedProposals', async () => {
      reply = json(201, { epoch: 5, seq: 78 })
      await rest.postCommit('g1', {
        ...body,
        rejected: [
          { pendingId: 'p1', reason: 'invalid_chain' },
          { proposalRef: 'ref1', reason: 'malformed' },
        ],
      })
      expect(last().body).toEqual({
        epoch: 4,
        commit: 'c',
        groupInfo: 'gi',
        ratchetTree: 'rt',
        welcome: null,
        batchId: 'b1',
        rejected: [{ pendingId: 'p1', reason: 'invalid_chain' }],
        rejectedProposals: [{ proposalRef: 'ref1', reason: 'malformed' }],
      })
    })

    it('declineBatch carries rejectedProposals only when present', async () => {
      reply = () => new Response(null, { status: 204 })
      await rest.declineBatch('b1', 'busy')
      expect(last().body).toEqual({ reason: 'busy' })
      reply = () => new Response(null, { status: 204 })
      await rest.declineBatch('b1', 'not_synced', [{ proposalRef: 'r', reason: 'invalid_chain' }])
      expect(last().body).toEqual({
        reason: 'not_synced',
        rejectedProposals: [{ proposalRef: 'r', reason: 'invalid_chain' }],
      })
    })

    it('409 EpochConflict resolves as a value with the DS epoch', async () => {
      reply = json(409, { error: 'EpochConflict', epoch: 6 })
      await expect(rest.postCommit('g1', body)).resolves.toEqual({
        ok: false,
        code: 'EpochConflict',
        epoch: 6,
      })
    })

    it('another 409, or EpochConflict without an epoch, rejects', async () => {
      reply = json(409, { error: 'GroupExists' })
      await expect(rest.postCommit('g1', body)).rejects.toMatchObject({ status: 409, code: 'GroupExists' })
      reply = json(409, { error: 'EpochConflict' })
      await expect(rest.postCommit('g1', body)).rejects.toMatchObject({ code: 'EpochConflict' })
    })

    it('403 IllegalMembership rejects with the user ids in details', async () => {
      reply = json(403, { error: 'IllegalMembership', userIds: ['u9'] })
      await expect(rest.postCommit('g1', body)).rejects.toMatchObject({
        status: 403,
        code: 'IllegalMembership',
        details: { userIds: ['u9'] },
      })
    })
  })

  describe('getChannelMlsGroup', () => {
    it('resolves the group', async () => {
      reply = json(200, { groupId: 'g1' })
      await expect(rest.getChannelMlsGroup('c1')).resolves.toEqual({ groupId: 'g1' })
      expect(last().url).toBe('http://api/v1/channels/c1/mls-group')
    })

    it('404 UnknownGroup resolves null', async () => {
      reply = json(404, { error: 'UnknownGroup' })
      await expect(rest.getChannelMlsGroup('c1')).resolves.toBeNull()
    })

    it('another 404 rejects', async () => {
      reply = json(404, { error: 'NotFound' })
      await expect(rest.getChannelMlsGroup('c1')).rejects.toMatchObject({ status: 404, code: 'NotFound' })
    })
  })

  it('429 rejects with RateLimited and the Retry-After seconds', async () => {
    reply = json(429, { error: 'RateLimited' }, { 'Retry-After': '12' })
    await expect(
      rest.uploadKeyPackages({ cipherSuite: 1, keyPackages: [], lastResort: null }),
    ).rejects.toMatchObject({
      status: 429,
      code: 'RateLimited',
      retryAfterSec: 12,
    })
  })

  it('signedAction goes in X-Hachiman-Signed-Action on the admin routes, and only when given', async () => {
    const opts = { signedAction: 'QUNU' }
    const routes = [
      () => rest.createRole('g', { name: 'r' }, opts),
      () => rest.updateRole('g', 'r', { permissions: 1 }, opts),
      () => rest.reorderRoles('g', [{ id: 'r', position: 1 }], opts),
      () => rest.deleteRole('g', 'r', opts),
      () => rest.putOverwrite('c', 't', { type: 'role', allow: 0, deny: 0 }, opts),
      () => rest.deleteOverwrite('c', 't', opts),
      () => rest.updateMember('g', 'u', { roles: ['r'] }, opts),
      () => rest.updateChannel('c', { historyVisibility: 'joined' }, opts),
      () => rest.updateGuild('g', {}, opts),
    ]
    for (const route of routes) {
      await route()
      expect(last().headers['X-Hachiman-Signed-Action']).toBe('QUNU')
    }
    await rest.updateRole('g', 'r', { name: 'x' })
    expect(last().headers).not.toHaveProperty('X-Hachiman-Signed-Action')
  })

  it('fetchBlob GETs the file URL without headers and returns the Blob', async () => {
    reply = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    const blob = await rest.fetchBlob('u1/blob')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(last()).toMatchObject({ url: 'http://api/v1/files/u1/blob', method: 'GET', headers: {} })
    reply = json(404, { error: 'NotFound' })
    await expect(rest.fetchBlob('u1/blob')).rejects.toMatchObject({ status: 404, code: 'NotFound' })
  })
})

describe('parseRetryAfter', () => {
  it.each([
    [null, null],
    ['5', 5],
    [' 30 ', 30],
    ['soon', null],
    ['-1', null],
  ] as const)('%s → %s', (v, want) => {
    expect(parseRetryAfter(v)).toBe(want)
  })

  it('takes an HTTP date relative to now, never below 0', () => {
    const now = Date.parse('2026-10-02T12:00:00Z')
    expect(parseRetryAfter('Fri, 02 Oct 2026 12:00:10 GMT', now)).toBe(10)
    expect(parseRetryAfter('Fri, 02 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })
})
