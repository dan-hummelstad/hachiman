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
  DocDecryptResult,
  DocEnvelopeKindName,
  EncryptedDocItem,
  EncryptedMessage,
  KindedContent,
  TrustInfo,
  UserId,
  WireMlsGroup,
} from '../api'
import { fromB64url, toB64url } from '../codec'
import { GROUP_ID_LENGTH } from '../constants'

export const STUB_MARKER = 'hachiman dev stub: NOT ENCRYPTED'

type StubEnvelope = {
  marker: typeof STUB_MARKER
  channelId: string
  clientMsgId: string
} & KindedContent<string>

interface StubDocEnvelope {
  marker: typeof STUB_MARKER
  channelId: string
  pageId: string
  kind: DocEnvelopeKindName
  bytes: B64url
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

type StubTrust = Pick<TrustInfo, 'state' | 'verifiedAt'>

/**
 * The trust of the preview's contacts (apps/hachiman/src/dev/preview/fixture.ts): yuki.h is
 * verified (M57), marlowe has a key and is not verified (M7). Everyone else has no key yet.
 */
const PREVIEW_TRUST: Readonly<Record<UserId, StubTrust>> = {
  'u-yuki': { state: 'verified', verifiedAt: '2026-10-02T12:00:00.000Z' },
  'u-marlowe': { state: 'tofu', verifiedAt: null },
}

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
  // setVerified changes a contact with a key for the session.
  const trust = new Map<UserId, StubTrust>(Object.entries(PREVIEW_TRUST))
  const trustOf = (u: UserId): TrustInfo => {
    const t = trust.get(u)
    return { userId: u, state: t?.state ?? 'unknown', masterKeyGeneration: t ? 1 : null, changedAt: null, verifiedAt: t?.verifiedAt ?? null }
  }

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
    const { kind, editOf, content } = e
    const body = { kind, editOf, content } as KindedContent<string>
    return {
      ...body,
      status: 'ok',
      messageId: m.id,
      clientMsgId: e.clientMsgId,
      sender: { userId: m.authorId, deviceId: m.senderDevice ?? deviceId, leafIndex: 0, trust: 'unknown', membershipVerified: false },
    }
  }

  function decryptDocOne(item: EncryptedDocItem): DocDecryptResult {
    let e: Partial<StubDocEnvelope>
    try {
      e = JSON.parse(new TextDecoder().decode(fromB64url(item.envelope))) as Partial<StubDocEnvelope>
    } catch {
      return { status: 'failed', id: item.id, reason: 'malformed' }
    }
    if (e.marker !== STUB_MARKER || typeof e.bytes !== 'string') return { status: 'failed', id: item.id, reason: 'malformed' }
    if (e.channelId !== item.channelId) return { status: 'failed', id: item.id, reason: 'wrong_channel' }
    if (e.pageId !== item.pageId) return { status: 'failed', id: item.id, reason: 'wrong_page' }
    if (e.kind !== item.kind) return { status: 'failed', id: item.id, reason: 'wrong_kind' }
    return {
      status: 'ok',
      id: item.id,
      kind: e.kind,
      bytes: fromB64url(e.bytes),
      sender: { userId: userId ?? '', deviceId: item.senderDevice ?? deviceId, leafIndex: 0, trust: 'unknown', membershipVerified: false },
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

    getTrust: (u) => Promise.resolve(trustOf(u)),
    listContactDevices: () => Promise.resolve([]),
    getSafetyNumber: () => Promise.resolve({ digits: '0'.repeat(60), groups: Array.from({ length: 12 }, () => '00000'), qrPayload: '' }),
    verifyQr: () => Promise.resolve({ userId: '', match: false }),
    setVerified(u, verified) {
      if (trust.has(u)) trust.set(u, verified ? { state: 'verified', verifiedAt: new Date().toISOString() } : { state: 'tofu', verifiedAt: null })
      return Promise.resolve(trustOf(u))
    },
    acknowledgeKeyChange: (u) => Promise.resolve(trustOf(u)),
    getEpochCode: () => Promise.resolve('0'.repeat(30)),

    sync: ok,
    onGatewayEvent: ok,
    ensureChannelGroup: (c) => Promise.resolve(group(c)),
    membershipTimeline: () => Promise.resolve([]),

    encryptMessage(input) {
      const clientMsgId = input.kind === 'edit' && input.editOf !== null ? input.editOf : stubId()
      const body = { kind: input.kind, editOf: input.editOf, content: { ...input.content, sentAtMs: Date.now() } } as KindedContent<string>
      const env: StubEnvelope = { ...body, marker: STUB_MARKER, channelId: input.channelId, clientMsgId }
      return Promise.resolve({ envelope: toB64url(utf8(JSON.stringify(env))), clientMsgId, groupId, epoch: 0 })
    },
    decryptMessages: (ms) => Promise.resolve(ms.map(decryptOne)),
    buildReport: () => Promise.resolve({ content: '', frankingKey: '' }),

    encryptDoc(input) {
      const env: StubDocEnvelope = { marker: STUB_MARKER, channelId: input.channelId, pageId: input.pageId, kind: input.kind, bytes: toB64url(input.bytes) }
      return Promise.resolve({ envelope: toB64url(utf8(JSON.stringify(env))), groupId, epoch: 0 })
    },
    decryptDoc: (items) => Promise.resolve(items.map(decryptDocOne)),

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
    // Every §2 bit (1 << 0 … 1 << 30): the stub has no admin chain, and preview mode plays its sounds.
    adminGuildPermissions: () => Promise.resolve(0x7fffffff),
    // A placeholder record and a random seed in the link format (43 base64url characters).
    prepareHistoryInvite: (input) =>
      Promise.resolve({ record: toB64url(utf8('hachiman-stub-invite-record')), linkSecret: toB64url(crypto.getRandomValues(new Uint8Array(32))), channelIds: [...input.channelIds].sort() }),
    sendInviteBundles: () => Promise.resolve({ groups: 0 }),
    redeemInvite: () => Promise.resolve({ groups: 0, keys: 0 }),
    // The preview has no DS: an unsigned placeholder.
    proveDevice: () => Promise.resolve({ ts: Date.now(), nonce: stubId(), sig: '' }),

    voiceStart: () => Promise.resolve({ handle: stubId(), keyPackage: '' }),
    voiceHandle: () => Promise.resolve([]),
    voiceAttachTransform: () => Promise.resolve(stubId()),
    voiceDetachTransform: ok,
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
