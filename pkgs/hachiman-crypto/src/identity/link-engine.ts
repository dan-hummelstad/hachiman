/**
 * The device-linking flows of IdentityService (docs/gateway-protocol.md §12.5): both roles, QR
 * and SAS mode, over the DS link session. The pure steps are in link.ts.
 */
import { x25519 } from '@noble/curves/ed25519.js'

import {
  CryptoError,
  type CryptoErrorCode,
  type DeviceCertificate,
  type DeviceId,
  type EngineContext,
  type HistoryKeyEntry,
  type LinkMessage,
  type LinkOffer,
  type LinkRole,
  type LinkSecrets,
  type LinkStart,
  type LinkTransfer,
  type SelfIdentity,
  type StoreSchema,
  type X25519KeyPair,
} from '../api'
import { fromB64url, toB64url } from '../codec'
import { HISTORY_BUNDLE_MAX_EPOCHS, LINK_MESSAGE_MAX_BYTES, LINK_SESSION_TTL_MS } from '../constants'
import { equalBytes } from './bytes'
import { encodeLinkOffer } from './codec'
import { sealHistoryKeys } from './device-message'
import { identity, keyPairMatches, verifyDeviceCert, verifyDskCert, verifyMasterSelfSignature } from './index'

type IdentityRow = StoreSchema['identity']

/** What the link engine needs from IdentityService. */
export interface LinkHost {
  ctx: EngineContext
  /** The ready identity (existing device role). Throws NoIdentity. */
  self(): SelfIdentity
  /** The own identity row, for the DSK private key. */
  row(): IdentityRow
  /** New device role: the pending device row (registered, keys made, no certificate). */
  pendingDevice(): Promise<IdentityRow>
  setLinking(): void
  /** InitOptions.deviceName: the certificate display_name of the new device. */
  deviceName(): string
  /** New device role: stores the verified transfer and turns the device ready. */
  completeNewDevice(row: IdentityRow, history: HistoryKeyEntry[]): Promise<void>
  /** Existing device role: epoch secrets for the new device. */
  exportHistory(): Promise<HistoryKeyEntry[]>
  /** A failure of background work (the history keys that did not fit in the transfer). */
  reportError(e: unknown): void
}

interface Session {
  id: string
  role: LinkRole
  offer: LinkOffer
  expiresAtMs: number
  lastSeq: number
  /** The device that the other side runs on. New device: set by the first accept. */
  peer: DeviceId | null
  ownEphemeral: X25519KeyPair
  linkSecret: Uint8Array | null
  existingPublic: Uint8Array | null
  newPublic: Uint8Array | null
  derived: { key: Uint8Array; transcriptHash: Uint8Array } | null
  phase: 'accept' | 'reveal' | 'confirm' | 'transfer' | 'done' | 'closed'
  timer: ReturnType<typeof setTimeout> | null
  queue: Promise<void>
}

export interface LinkEngine {
  linkAsNewDevice(mode: 'qr' | 'sas'): Promise<LinkStart>
  linkScan(qrPayload: string): Promise<{ sessionId: string; newDeviceName: string }>
  linkAccept(sessionId: string): Promise<void>
  listLinkSessions(): Promise<{ sessionId: string; newDeviceName: string; platform: LinkOffer['platform']; createdAt: string }[]>
  linkConfirmSas(sessionId: string, matches: boolean): Promise<void>
  linkCancel(sessionId: string): Promise<void>
  onEvent(d: { sessionId: string; seq: number; fromDevice: DeviceId }): Promise<void>
}

function errorCode(e: unknown): CryptoErrorCode {
  if (e instanceof CryptoError) return e.code
  // A session that the DS deleted or expired (410 LinkExpired): the peer cancelled or time ran out.
  if (typeof e === 'object' && e !== null && 'dsCode' in e) return e.dsCode === 'LinkExpired' ? 'LinkExpired' : 'LinkAborted'
  return 'LinkAborted'
}

/** Each group's newest keys first, groups interleaved: a cut keeps the recent history of every group. */
function newestFirst(keys: HistoryKeyEntry[]): HistoryKeyEntry[] {
  const top = new Map<string, number>()
  const tagged = keys.map((k) => ({ k, g: toB64url(k.groupId) }))
  for (const { k, g } of tagged) top.set(g, Math.max(top.get(g) ?? 0, k.epoch))
  return tagged
    .map(({ k, g }) => ({ k, age: top.get(g)! - k.epoch }))
    .sort((a, b) => a.age - b.age)
    .map(({ k }) => k)
}

export function createLinkEngine(host: LinkHost): LinkEngine {
  const { ctx } = host
  const sessions = new Map<string, Session>()

  function newEphemeral(): X25519KeyPair {
    const privateKey = x25519.utils.randomSecretKey()
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
  }

  function close(s: Session, ok: boolean, error: CryptoErrorCode | null): void {
    if (s.phase === 'closed') return
    s.phase = 'closed'
    if (s.timer !== null) clearTimeout(s.timer)
    sessions.delete(s.id)
    ctx.emit('linkDone', { sessionId: s.id, role: s.role, ok, error })
  }

  function track(s: Session): void {
    sessions.set(s.id, s)
    const ms = Math.max(0, s.expiresAtMs - ctx.now())
    s.timer = setTimeout(() => {
      close(s, false, 'LinkExpired')
    }, ms)
  }

  function live(s: Session): void {
    if (ctx.now() >= s.expiresAtMs) {
      close(s, false, 'LinkExpired')
      throw new CryptoError('LinkExpired', 'the link session expired')
    }
  }

  async function post(s: Session, m: LinkMessage): Promise<void> {
    await ctx.transport.postLinkMessage(s.id, { body: toB64url(identity.link.encodeMessage(m)) })
  }

  async function abort(s: Session, reason: 'sas_mismatch' | 'cancelled' | 'error', code: CryptoErrorCode): Promise<void> {
    try {
      await post(s, { type: 'abort', reason })
    } catch {
      // The session may already be gone on the DS.
    }
    close(s, false, code)
  }

  function derive(s: Session): void {
    if (s.existingPublic === null || s.newPublic === null) throw new CryptoError('Malformed', 'link keys missing')
    const d = identity.link.deriveSession({
      offer: s.offer,
      existingPublic: s.existingPublic,
      newPublic: s.newPublic,
      ownPrivate: s.ownEphemeral.privateKey,
      linkSecret: s.linkSecret,
    })
    s.derived = { key: d.key, transcriptHash: d.transcriptHash }
    if (s.offer.mode === 'sas') ctx.emit('linkSas', { sessionId: s.id, emoji: d.sas })
  }

  // MARK: existing device

  /**
   * Certifies the new device and sends the transfer. One link message holds at most
   * LINK_MESSAGE_MAX_BYTES: the transfer carries the newest keys of each group that fit, and the
   * rest goes to the new device as history_keys device messages. The size is fixed before the
   * certificate PUT, so the post cannot fail on size after the device is active.
   */
  async function sendTransfer(s: Session): Promise<void> {
    const derived = s.derived
    if (derived === null) throw new CryptoError('Malformed', 'no link key')
    const self = host.self()
    const row = host.row()
    if (row.dsk === null) throw new CryptoError('NoIdentity', 'this device has no device-signing key')
    const cert = identity.certifyDevice(
      { cert: self.chain.dsk, keyPair: { publicKey: self.chain.dsk.publicKey, privateKey: row.dsk.privateKey } },
      { deviceId: s.offer.deviceId, mlsSignatureKey: s.offer.mlsSignatureKey, hpkeKey: s.offer.hpkeKey, issuedAtMs: ctx.now(), displayName: s.offer.deviceName },
    )
    const history = newestFirst(await host.exportHistory())
    const dskPrivateKey = row.dsk.privateKey
    const message = (n: number): LinkMessage => {
      const transfer: LinkTransfer = { master: self.chain.master, dskCert: self.chain.dsk, dskPrivateKey, deviceCertificate: cert, historyKeys: history.slice(0, n) }
      return { type: 'transfer', sealed: identity.link.sealTransfer(derived.key, derived.transcriptHash, transfer) }
    }
    const fits = (n: number): boolean => identity.link.encodeMessage(message(n)).length <= LINK_MESSAGE_MAX_BYTES
    let n = history.length
    if (!fits(n)) {
      // The largest n that fits.
      let lo = 0
      let hi = n - 1
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (fits(mid)) lo = mid
        else hi = mid - 1
      }
      n = lo
    }
    await ctx.transport.putDeviceCertificate(s.offer.deviceId, { certificate: toB64url(identity.encodeDeviceCertificate(cert)) })
    s.phase = 'done'
    await post(s, message(n))
    if (n < history.length) void sendHistoryRest(s.offer, history.slice(n)).catch(host.reportError)
  }

  /**
   * The keys that did not fit in the transfer, one history_keys response per group (§12.5). The
   * new device opens them once it is ready (they wait in its inbox). A rate limit waits and tries
   * again.
   */
  async function sendHistoryRest(offer: LinkOffer, keys: HistoryKeyEntry[]): Promise<void> {
    const self = host.self()
    const groups = new Map<string, HistoryKeyEntry[]>()
    for (const k of keys) {
      const g = toB64url(k.groupId)
      groups.set(g, [...(groups.get(g) ?? []), k])
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.epoch - b.epoch)
      for (let i = 0; i < list.length; i += HISTORY_BUNDLE_MAX_EPOCHS) {
        const chunk = list.slice(i, i + HISTORY_BUNDLE_MAX_EPOCHS)
        const sealed = await sealHistoryKeys({ deviceId: self.deviceId, signatureKey: self.mlsSignatureKey.privateKey }, offer, {
          type: 'response',
          groupId: chunk[0]!.groupId,
          epochFrom: chunk[0]!.epoch,
          epochTo: chunk[chunk.length - 1]!.epoch,
          keys: chunk.map((k) => ({ epoch: k.epoch, secret: k.secret })),
        })
        for (;;) {
          try {
            await ctx.transport.postInbox(offer.deviceId, { kind: 'history_keys', body: toB64url(sealed) })
            break
          } catch (e) {
            if ((e as { dsCode?: string } | null)?.dsCode !== 'RateLimited') throw e
            // ponytail: a fixed wait; the inbox limit is per minute (§12.18 rate limits).
            await new Promise((resolve) => setTimeout(resolve, 60_000))
          }
        }
      }
    }
  }

  async function existingStep(s: Session, m: LinkMessage): Promise<void> {
    if (m.type === 'reveal' && s.phase === 'reveal') {
      s.newPublic = m.ephemeralPublic
      try {
        derive(s)
      } catch (e) {
        await abort(s, 'error', errorCode(e))
        return
      }
      s.phase = 'confirm'
    } else if (m.type === 'done' && s.phase === 'done') {
      const ok = s.derived !== null && identity.link.verifyConfirmation(s.derived.key, s.derived.transcriptHash, m.confirmation)
      close(s, ok, ok ? null : 'LinkAborted')
      await ctx.transport.deleteLinkSession(s.id).catch(() => undefined)
    }
  }

  // MARK: new device

  async function verifyTransfer(s: Session, t: LinkTransfer): Promise<void> {
    const pending = await host.pendingDevice()
    const fail = (why: string): never => {
      throw new CryptoError('InvalidChain', `link transfer: ${why}`)
    }
    if (t.master.userId !== pending.userId || !verifyMasterSelfSignature(t.master)) fail('bad master key record')
    if (!verifyDskCert(t.dskCert, t.master) || !keyPairMatches(t.dskPrivateKey, t.dskCert.publicKey)) fail('bad device-signing key')
    const c: DeviceCertificate = t.deviceCertificate
    if (c.deviceId !== pending.deviceId || !equalBytes(c.mlsSignatureKey, pending.mlsSignatureKey.publicKey) || !equalBytes(c.hpkeKey, pending.hpkeKey.publicKey)) {
      fail('the certificate does not hold the keys of this device')
    }
    if (!verifyDeviceCert(c, t.dskCert)) fail('bad device certificate')
    // The DS must publish the same identity, else the existing device and the DS disagree.
    const keys = await ctx.transport.getUserKeys(pending.userId)
    if (keys.masterKey === null || !equalBytes(fromB64url(keys.masterKey.record), identity.encodeMasterKeyRecord(t.master))) fail('the DS has another master key')
    if (keys.deviceSigningKey?.generation !== t.dskCert.generation) fail('the DS has another device-signing key')
    const row: IdentityRow = {
      ...pending,
      deviceCertificate: identity.encodeDeviceCertificate(c),
      dsk: { cert: identity.encodeDskCert(t.dskCert), privateKey: t.dskPrivateKey },
      master: { record: identity.encodeMasterKeyRecord(t.master), privateKey: null },
    }
    if (s.derived === null) fail('no link key')
    await host.completeNewDevice(row, t.historyKeys)
  }

  async function newDeviceStep(s: Session, m: LinkMessage, from: DeviceId): Promise<void> {
    if (m.type === 'accept' && s.phase === 'accept') {
      if (m.existingDeviceId !== from) return
      s.peer = from
      s.existingPublic = m.ephemeralPublic
      if (s.offer.mode === 'sas') await post(s, { type: 'reveal', ephemeralPublic: s.ownEphemeral.publicKey })
      derive(s)
      s.phase = 'transfer'
    } else if (m.type === 'transfer' && s.phase === 'transfer' && s.derived !== null) {
      const t = identity.link.openTransfer(s.derived.key, s.derived.transcriptHash, m.sealed)
      await verifyTransfer(s, t)
      await post(s, { type: 'done', confirmation: identity.link.confirmation(s.derived.key, s.derived.transcriptHash) })
      close(s, true, null)
    }
  }

  async function process(s: Session): Promise<void> {
    live(s)
    const msgs = await ctx.transport.fetchLinkMessages(s.id, s.lastSeq)
    const ownId = s.role === 'new_device' ? s.offer.deviceId : host.self().deviceId
    for (const wire of msgs) {
      if (s.phase === 'closed') return
      if (wire.seq <= s.lastSeq) continue
      s.lastSeq = wire.seq
      if (wire.fromDevice === ownId) continue
      const expectedPeer = s.role === 'new_device' ? s.peer : s.offer.deviceId
      if (expectedPeer !== null && wire.fromDevice !== expectedPeer) continue
      let m: LinkMessage
      try {
        m = identity.link.decodeMessage(fromB64url(wire.body))
      } catch {
        continue
      }
      if (m.type === 'abort') {
        close(s, false, m.reason === 'sas_mismatch' ? 'SasMismatch' : 'LinkAborted')
        return
      }
      if (s.role === 'new_device') await newDeviceStep(s, m, wire.fromDevice)
      else await existingStep(s, m)
    }
  }

  /** Serializes the work on one session and turns failures into an abort. */
  function run(s: Session, fn: () => Promise<void>): Promise<void> {
    const next = s.queue.then(async () => {
      if (s.phase === 'closed') return
      try {
        await fn()
      } catch (e) {
        // fn may have closed the session (the phase changes behind the narrowing).
        if ((s.phase as Session['phase']) !== 'closed') await abort(s, 'error', errorCode(e))
        throw e
      }
    })
    s.queue = next.catch(() => undefined)
    return next
  }

  function session(sessionId: string): Session {
    const s = sessions.get(sessionId)
    if (!s) throw new CryptoError('LinkAborted', 'unknown link session')
    return s
  }

  async function findOffer(sessionId: string): Promise<{ offer: LinkOffer; expiresAtMs: number; createdAt: string }> {
    const list = await ctx.transport.listLinkSessions()
    const w = list.find((x) => x.id === sessionId)
    if (!w) throw new CryptoError('LinkExpired', 'the link session is gone')
    const offer = identity.link.decodeOffer(fromB64url(w.offer))
    if (w.newDeviceId !== offer.deviceId) throw new CryptoError('LinkAborted', 'the session device differs from the offer')
    return { offer, expiresAtMs: Date.parse(w.expiresAt), createdAt: w.createdAt }
  }

  function existingSession(id: string, offer: LinkOffer, expiresAtMs: number): Session {
    const self = host.self()
    if (offer.userId !== self.userId) throw new CryptoError('LinkAborted', 'the offer is for another account')
    if (offer.deviceId === self.deviceId) throw new CryptoError('LinkAborted', 'the offer is for this device')
    if (sessions.has(id)) throw new CryptoError('LinkAborted', 'the link session is already in use')
    const ownEphemeral = newEphemeral()
    return {
      id,
      role: 'existing_device',
      offer,
      expiresAtMs: Math.min(expiresAtMs, ctx.now() + LINK_SESSION_TTL_MS),
      lastSeq: 0,
      peer: offer.deviceId,
      ownEphemeral,
      linkSecret: null,
      existingPublic: ownEphemeral.publicKey,
      newPublic: null,
      derived: null,
      phase: 'accept',
      timer: null,
      queue: Promise.resolve(),
    }
  }

  return {
    async linkAsNewDevice(mode) {
      const pending = await host.pendingDevice()
      host.setLinking()
      const created = identity.link.createOffer(
        {
          userId: pending.userId,
          deviceId: pending.deviceId,
          mlsSignatureKey: pending.mlsSignatureKey.publicKey,
          hpkeKey: pending.hpkeKey.publicKey,
          deviceName: host.deviceName(),
          platform: ctx.platform,
        },
        mode,
      )
      const secrets: LinkSecrets = created.secrets
      const res = await ctx.transport.createLinkSession({ offer: toB64url(encodeLinkOffer(created.offer)) })
      const s: Session = {
        id: res.id,
        role: 'new_device',
        offer: created.offer,
        expiresAtMs: Math.min(Date.parse(res.expiresAt), ctx.now() + LINK_SESSION_TTL_MS),
        lastSeq: 0,
        peer: null,
        ownEphemeral: secrets.ephemeral,
        linkSecret: secrets.linkSecret,
        existingPublic: null,
        newPublic: secrets.ephemeral.publicKey,
        derived: null,
        phase: 'accept',
        timer: null,
        queue: Promise.resolve(),
      }
      track(s)
      const qrPayload = mode === 'qr' && secrets.linkSecret !== null ? identity.link.encodeQr(created.offer, res.id, secrets.ephemeral.publicKey, secrets.linkSecret) : null
      return { sessionId: res.id, qrPayload }
    },

    async linkScan(qrPayload) {
      const qr = identity.link.parseQr(qrPayload)
      const server = await findOffer(qr.sessionId)
      if (!equalBytes(encodeLinkOffer(server.offer), encodeLinkOffer(qr.offer))) throw new CryptoError('LinkAborted', 'the DS offer differs from the QR code')
      const s = existingSession(qr.sessionId, qr.offer, server.expiresAtMs)
      s.linkSecret = qr.linkSecret
      s.newPublic = qr.ephemeralPublic
      track(s)
      await run(s, async () => {
        live(s)
        await post(s, { type: 'accept', existingDeviceId: host.self().deviceId, ephemeralPublic: s.ownEphemeral.publicKey })
        derive(s)
        await sendTransfer(s)
      })
      return { sessionId: s.id, newDeviceName: s.offer.deviceName }
    },

    async linkAccept(sessionId) {
      const server = await findOffer(sessionId)
      if (server.offer.mode !== 'sas') throw new CryptoError('LinkAborted', 'a QR session needs a scan')
      const s = existingSession(sessionId, server.offer, server.expiresAtMs)
      track(s)
      await run(s, async () => {
        live(s)
        s.phase = 'reveal'
        await post(s, { type: 'accept', existingDeviceId: host.self().deviceId, ephemeralPublic: s.ownEphemeral.publicKey })
      })
    },

    async listLinkSessions() {
      const self = host.self()
      const now = ctx.now()
      const out: { sessionId: string; newDeviceName: string; platform: LinkOffer['platform']; createdAt: string }[] = []
      for (const w of await ctx.transport.listLinkSessions()) {
        let offer: LinkOffer
        try {
          offer = identity.link.decodeOffer(fromB64url(w.offer))
        } catch {
          continue
        }
        if (offer.userId !== self.userId || offer.deviceId === self.deviceId || w.newDeviceId !== offer.deviceId || Date.parse(w.expiresAt) <= now) continue
        out.push({ sessionId: w.id, newDeviceName: offer.deviceName, platform: offer.platform, createdAt: w.createdAt })
      }
      return out
    },

    async linkConfirmSas(sessionId, matches) {
      const s = session(sessionId)
      await run(s, async () => {
        live(s)
        if (s.role !== 'existing_device' || s.phase !== 'confirm') throw new CryptoError('LinkAborted', 'nothing to confirm')
        if (!matches) {
          await abort(s, 'sas_mismatch', 'SasMismatch')
          return
        }
        await sendTransfer(s)
      })
    },

    async linkCancel(sessionId) {
      const s = sessions.get(sessionId)
      if (s) await abort(s, 'cancelled', 'LinkAborted')
      // The new device owns the session. The existing device leaves it, so the abort is still readable.
      if (!s || s.role === 'new_device') await ctx.transport.deleteLinkSession(sessionId).catch(() => undefined)
    },

    async onEvent(d) {
      const s = sessions.get(d.sessionId)
      if (!s) return
      await run(s, () => process(s)).catch(() => undefined)
    },
  }
}
