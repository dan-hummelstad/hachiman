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
  SafetyNumber,
  TrustInfo,
  UserId,
  WireMlsGroup,
} from '../api'
import { fromB64url, toB64url } from '../codec'
import { GROUP_ID_LENGTH, VERIFY_QR_PREFIX } from '../constants'

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

type StubTrust = Pick<TrustInfo, 'state' | 'verifiedAt' | 'changedAt'>

/**
 * The trust of the preview's contacts (apps/hachiman/src/dev/preview/fixture.ts): yuki.h is
 * verified (M57), marlowe has a key and is not verified (M7). Everyone else has no key yet.
 */
const PREVIEW_TRUST: Readonly<Record<UserId, StubTrust>> = {
  'u-yuki': { state: 'verified', verifiedAt: '2026-10-02T12:00:00.000Z', changedAt: null },
  'u-marlowe': { state: 'tofu', verifiedAt: null, changedAt: null },
}

/** The contact of each pushed key change: verified yuki.h blocks (M58), marlowe is a notice (M59). */
const PREVIEW_KEY_CHANGE_USER = { blocking: 'u-yuki', notice: 'u-marlowe' } as const

/**
 * The time of a pushed key change: now, but not before 12:00 today. The fixture messages of today
 * end before 12:00, so the key change line always comes after them in the transcript (M59).
 */
function previewChangedAt(): string {
  const noon = new Date().setHours(12, 0, 0, 0)
  return new Date(Math.max(Date.now(), noon)).toISOString()
}

/** A fixed, non-zero safety number for each contact, so the verify sheet shows real content (M9). */
function previewSafetyNumber(u: UserId): SafetyNumber {
  let h = 2166136261
  for (const c of u) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  let digits = ''
  while (digits.length < 60) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    digits += (h % 100000).toString().padStart(5, '0')
  }
  return { digits, groups: digits.match(/\d{5}/g) ?? [], qrPayload: VERIFY_QR_PREFIX + toB64url(utf8(u)) }
}

/** After init, the time until the stub pushes the key change of `?keychange=`, as a live event. */
const KEY_CHANGE_DELAY_MS = 1000

/**
 * `?preview&keychange=blocking` or `?preview&keychange=notice`: the key change that the stub
 * pushes after init, as the Worker does when a chain fetch finds a new master key. Else null.
 */
function previewKeyChange(): CryptoEvents['keyChange'] | null {
  const search = 'location' in globalThis ? globalThis.location.search : ''
  const severity = new URLSearchParams(search).get('keychange')
  return severity === 'blocking' || severity === 'notice' ? { userId: PREVIEW_KEY_CHANGE_USER[severity], severity } : null
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
  // setVerified, acknowledgeKeyChange and a pushed key change change a contact with a key for the session.
  const trust = new Map<UserId, StubTrust>(Object.entries(PREVIEW_TRUST))
  const trustOf = (u: UserId): TrustInfo => {
    const t = trust.get(u)
    return { userId: u, state: t?.state ?? 'unknown', masterKeyGeneration: t ? 1 : null, changedAt: t?.changedAt ?? null, verifiedAt: t?.verifiedAt ?? null }
  }
  let keyChangeTimer: ReturnType<typeof setTimeout> | undefined
  // As the Worker's updateContact: the contact is 'changed' until verified or acknowledged, and the change clears verifiedAt.
  const pushKeyChange = (change: CryptoEvents['keyChange']): void => {
    trust.set(change.userId, { state: 'changed', verifiedAt: null, changedAt: previewChangedAt() })
    emit('keyChange', change)
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
      const change = previewKeyChange()
      clearTimeout(keyChangeTimer)
      if (change !== null) keyChangeTimer = setTimeout(() => { pushKeyChange(change) }, KEY_CHANGE_DELAY_MS)
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
    // Each contact with a key has a desktop and a phone (M9).
    listContactDevices: (u) =>
      Promise.resolve(
        trust.has(u)
          ? [
              { deviceId: `${u}-desktop`, displayName: 'Desktop', dskGeneration: 1, issuedAtMs: Date.UTC(2026, 7, 14) },
              { deviceId: `${u}-phone`, displayName: 'Phone', dskGeneration: 1, issuedAtMs: Date.UTC(2026, 8, 2) },
            ]
          : [],
      ),
    getSafetyNumber: (u) => Promise.resolve(previewSafetyNumber(u)),
    verifyQr: () => Promise.resolve({ userId: '', match: false }),
    setVerified(u, verified) {
      if (trust.has(u)) trust.set(u, verified ? { state: 'verified', verifiedAt: new Date().toISOString(), changedAt: null } : { state: 'tofu', verifiedAt: null, changedAt: null })
      return Promise.resolve(trustOf(u))
    },
    // Accepting the new key pins it: the contact is not verified any more (§12.5 TOFU).
    acknowledgeKeyChange(u) {
      if (trust.get(u)?.state === 'changed') trust.set(u, { state: 'tofu', verifiedAt: null, changedAt: null })
      return Promise.resolve(trustOf(u))
    },
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
      clearTimeout(keyChangeTimer)
      listeners.clear()
    },
  }
  return client
}
