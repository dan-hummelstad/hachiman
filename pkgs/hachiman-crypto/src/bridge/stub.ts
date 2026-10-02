/**
 * The CryptoClient of the dev preview (apps/hachiman/src/dev/preview). No Worker, no keys, no
 * store. The identity is 'ready' at once.
 *
 * NOT ENCRYPTED: an envelope is base64url(JSON) with the marker STUB_MARKER, and attachments pass
 * through unchanged. Never use it outside the preview.
 */
import type {
  B64url,
  CreateCryptoStub,
  CryptoClient,
  CryptoEvents,
  CryptoStatus,
  DecryptResult,
  EncryptedMessage,
  MessageContent,
  UserId,
  WireMlsGroup,
} from '../api'
import { fromB64url, toB64url } from '../codec'
import { GROUP_ID_LENGTH } from '../constants'

export const STUB_MARKER = 'hachiman dev stub: NOT ENCRYPTED'

interface StubEnvelope {
  marker: typeof STUB_MARKER
  channelId: string
  clientMsgId: string
  kind: 'message' | 'edit'
  editOf: string | null
  content: MessageContent
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

function stubId(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(16)))
}

function parseEnvelope(b64: B64url): StubEnvelope | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(fromB64url(b64))) as Partial<StubEnvelope>
    return v.marker === STUB_MARKER && typeof v.content === 'object' ? (v as StubEnvelope) : null
  } catch {
    return null
  }
}

export const createCryptoStub: CreateCryptoStub = () => {
  const listeners = new Map<keyof CryptoEvents, Set<(payload: never) => void>>()
  let userId: UserId | null = null
  const deviceId = crypto.randomUUID()
  const groupId = toB64url(new Uint8Array(GROUP_ID_LENGTH))

  const status = (): CryptoStatus => ({ state: 'ready', userId, deviceId, primary: true, recoveryConfigured: true, hostTrust: 'server_code' })
  function emit<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void {
    for (const cb of listeners.get(event) ?? []) (cb as (p: CryptoEvents[K]) => void)(payload)
  }
  const group = (channelId: string): WireMlsGroup => ({
    groupId,
    kind: 'channel',
    guildId: null,
    channelId,
    generation: 0,
    cipherSuite: 1,
    status: 'active',
    epoch: 0,
    historyVisibility: 'joined',
    latestSeq: 0,
    member: true,
  })
  const ok = (): Promise<void> => Promise.resolve()

  function decryptOne(m: EncryptedMessage): DecryptResult {
    const e = parseEnvelope(m.envelope)
    if (e === null) return { status: 'failed', messageId: m.id, reason: 'malformed' }
    if (e.channelId !== m.channelId) return { status: 'failed', messageId: m.id, reason: 'wrong_channel' }
    return {
      status: 'ok',
      messageId: m.id,
      clientMsgId: e.clientMsgId,
      kind: e.kind,
      editOf: e.editOf,
      content: e.content,
      sender: { userId: m.authorId, deviceId: m.senderDevice ?? deviceId, leafIndex: 0, trust: 'unknown', membershipVerified: false },
    }
  }

  const client: CryptoClient = {
    init(opts) {
      userId = opts.userId
      emit('status', status())
      return Promise.resolve(status())
    },
    status: () => Promise.resolve(status()),
    signOutDevice: ok,

    setupFirstDevice: () => Promise.resolve({ recoveryKey: 'HRK1-STUB0-STUB0-STUB0', status: status() }),
    restoreFromRecoveryKey: () => Promise.resolve(status()),
    resetIdentity: () => Promise.resolve({ recoveryKey: 'HRK1-STUB0-STUB0-STUB0', status: status() }),
    rotateRecoveryKey: () => Promise.resolve({ recoveryKey: 'HRK1-STUB0-STUB0-STUB0' }),

    linkAsNewDevice: () => Promise.resolve({ sessionId: stubId(), qrPayload: null }),
    linkScan: () => Promise.resolve({ sessionId: stubId(), newDeviceName: 'Preview device' }),
    linkAccept: ok,
    listLinkSessions: () => Promise.resolve([]),
    linkConfirmSas: ok,
    linkCancel: ok,

    listDevices: () =>
      Promise.resolve([{ id: deviceId, name: 'Preview', platform: 'browser', status: 'active', current: true, primary: true, lastSeenAt: null, createdAt: new Date(0).toISOString() }]),
    revokeDevice: ok,
    renameDevice: ok,

    getTrust: (u) => Promise.resolve({ userId: u, state: 'unknown', masterKeyGeneration: null, changedAt: null }),
    listContactDevices: () => Promise.resolve([]),
    getSafetyNumber: () => Promise.resolve({ digits: '0'.repeat(60), groups: Array.from({ length: 12 }, () => '00000'), qrPayload: '' }),
    verifyQr: () => Promise.resolve({ userId: '', match: false }),
    setVerified: (u) => Promise.resolve({ userId: u, state: 'unknown', masterKeyGeneration: null, changedAt: null }),
    acknowledgeKeyChange: (u) => Promise.resolve({ userId: u, state: 'unknown', masterKeyGeneration: null, changedAt: null }),
    getEpochCode: () => Promise.resolve('0'.repeat(30)),

    sync: ok,
    onGatewayEvent: ok,
    ensureChannelGroup: (c) => Promise.resolve(group(c)),
    membershipTimeline: () => Promise.resolve([]),

    encryptMessage(input) {
      const clientMsgId = input.kind === 'edit' && input.editOf !== null ? input.editOf : stubId()
      const env: StubEnvelope = { marker: STUB_MARKER, channelId: input.channelId, clientMsgId, kind: input.kind, editOf: input.editOf, content: { ...input.content, sentAtMs: Date.now() } }
      return Promise.resolve({ envelope: toB64url(utf8(JSON.stringify(env))), clientMsgId, groupId, epoch: 0 })
    },
    decryptMessages: (ms) => Promise.resolve(ms.map(decryptOne)),
    buildReport: () => Promise.resolve({ content: '', frankingKey: '' }),

    encryptAttachment(input) {
      const t = input.thumbnail
      return Promise.resolve({
        blob: input.file,
        thumbnailBlob: t?.blob ?? null,
        draft: {
          key: '',
          sha256: '',
          size: input.file.size,
          blobSize: input.file.size,
          mime: input.mime,
          name: input.name,
          width: input.width,
          height: input.height,
          durationMs: input.durationMs,
          blurhash: input.blurhash,
          thumbnail: t === null ? null : { key: '', sha256: '', size: t.blob.size, blobSize: t.blob.size, mime: t.mime, width: t.width, height: t.height },
        },
      })
    },
    decryptAttachment: (p, blob) => Promise.resolve(new Blob([blob], { type: p.mime })),

    backupNow: () => Promise.resolve({ uploaded: 0 }),
    ktSelfCheck: () => Promise.resolve({ ok: true, treeSize: 0, unknownEntries: [] }),
    signAdminAction: () => Promise.resolve({ header: toB64url(utf8('hachiman-stub-admin-action')), seq: 0 }),

    voiceStart: () => Promise.resolve({ handle: stubId(), keyPackage: '' }),
    voiceHandle: () => Promise.resolve([]),
    voiceAttachTransform: ok,
    voiceRoster: () => Promise.resolve([]),
    voiceEpochCode: () => Promise.resolve(null),
    voiceStop: ok,

    on(event, cb) {
      let set = listeners.get(event)
      if (set === undefined) listeners.set(event, (set = new Set()))
      const f = cb as (payload: never) => void
      set.add(f)
      return () => {
        set.delete(f)
      }
    },
    dispose() {
      listeners.clear()
    },
  }
  return client
}
