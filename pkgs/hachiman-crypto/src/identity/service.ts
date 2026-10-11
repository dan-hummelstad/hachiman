/**
 * IdentityService (docs/gateway-protocol.md §12.4, §12.5, §12.11.3, §12.14, §12.16): the own
 * identity, device linking and revocation, TOFU pins and chain contexts, key packages, backups,
 * key transparency and the signed admin chain.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'

import {
  CryptoError,
  type AdminAction,
  type AdminReplayState,
  type ChainContext,
  type ContactDevice,
  type CreateIdentityService,
  type CryptoGatewayEvent,
  type CryptoState,
  type CryptoStatus,
  type DeviceCertificate,
  type DeviceChain,
  type DeviceId,
  type DeviceSigningKeyCert,
  type DeviceSummary,
  type Ed25519KeyPair,
  type HistoryKeyEntry,
  type IdentityService,
  type InitOptions,
  type KtEntry,
  type KtSelfCheckResult,
  type MasterKeyRecord,
  type RevocationReasonName,
  type SelfIdentity,
  type SenderTrust,
  type StoreSchema,
  type TrustInfo,
  type UserId,
  type WireInboxItem,
} from '../api'
import { fromB64url, toB64url } from '../codec'
import {
  BackupKind,
  CipherSuite,
  DeviceRevocationReason,
  HISTORY_BUNDLE_MAX_EPOCHS,
  KEY_PACKAGE_LIFETIME_MS,
  KEY_PACKAGE_TARGET,
  KtEntryType,
  type CipherSuiteId,
} from '../constants'
import { admin as adminModule } from '../admin/index'
import { dsCodeOf, reportError as emitError } from '../errors'
import { createKtClient } from '../kt/client'
import { kt as ktModule } from '../kt/index'
import { importEpochSecrets, markEpochSecretsBackedUp } from '../mls/epoch-secrets'
import { DEVICE_PROOF_NONCE_BYTES, deviceProofMessage, type DeviceProof, type DeviceProofInput } from '../device-proof'
import { generateEd25519 } from '../sign'
import { equalBytes } from './bytes'
import { decodeDskTransfer, encodeDskTransfer, groupHistory } from './codec'
import { openDeviceMessage, sealDeviceMessage } from './device-message'
import { identity, keyPairMatches, verifyDeviceCert, verifyDskCert, verifyMasterSelfSignature } from './index'
import { createLinkEngine } from './link-engine'
import type { BackupKeys } from './recovery'

/** The store row of this device. */
type IdentityRow = StoreSchema['identity']

const SELF = 'self'
/** Fetched user keys stay cached this long unless a USER_KEYS_UPDATE invalidates them. */
const USER_KEYS_TTL_MS = 5 * 60_000
/**
 * An unknown device id refetches the user's keys at most this often. A new device also arrives as
 * USER_KEYS_UPDATE, which drops the cache, so the limit only stops a refetch per message.
 */
export const KEY_REFRESH_MIN_MS = 10_000
/** §12.11.3: a history blob per group at 64 unbacked epochs, or after 24 h. */
const BACKUP_EPOCH_THRESHOLD = 64
const BACKUP_INTERVAL_MS = 24 * 60 * 60_000
/** Keys per history blob: 4096 × 42 bytes stays far below the 1 MiB blob limit. */
const BACKUP_BATCH_KEYS = 4096
/** History keys per group in a LinkTransfer. */
/** The start-up revocation check waits at most this long, so an offline start is not held up. */
const START_CHECK_MS = 5_000
const MAX_UPLOAD_PER_CALL = 100
/** Master generations that a reset tries after a password reset (see createIdentity). */
const RESET_GENERATION_PROBES = 64
const SUPPORTED_SUITES: readonly CipherSuiteId[] = [CipherSuite.X25519_AES128GCM_SHA256_ED25519, CipherSuite.XWING_AES256GCM_SHA512_ED25519]

const REASON_ID: Record<Exclude<RevocationReasonName, 'password_reset' | 'signed_out'>, 1 | 2 | 4> = {
  user: DeviceRevocationReason.USER,
  lost: DeviceRevocationReason.LOST,
  compromised: DeviceRevocationReason.COMPROMISED,
}

/** A user's keys after every signature check. */
interface VerifiedKeys {
  userId: UserId
  fetchedAtMs: number
  /** The pinned master (own row for this user). */
  master: MasterKeyRecord
  dsk: DeviceSigningKeyCert | null
  /** Certificates that verify under a known DSK of this user, revoked devices included. */
  certs: Map<DeviceId, DeviceCertificate>
  revoked: Set<DeviceId>
  /** Unchecked: the DS reports a master that differs from the pin (self only). */
  masterMismatch: boolean
  /** A contact whose served master is a candidate, not the pin (trust 'changed', §12.5). */
  pendingChange: boolean
}

const groupKey = (groupId: Uint8Array): string => toB64url(groupId)

export const createIdentityService: CreateIdentityService = (ctx, deps) => {
  const { store, transport } = ctx
  let init: InitOptions | null = null
  let row: IdentityRow | null = null
  let self: SelfIdentity | null = null
  let state: CryptoState = 'needs_identity'
  const keyCache = new Map<UserId, { at: number; value: Promise<VerifiedKeys | null> }>()
  /** DSK public keys per user and generation that verified under the pinned master. */
  const knownDsks = new Map<UserId, Map<number, Uint8Array>>()
  const dskListeners: (() => void)[] = []
  const lastHistoryBackup = new Map<string, number>()
  let replenishing: Promise<void> | null = null
  /** The MLS key of a POST /devices in flight: proveDevice signs with it before the row exists. */
  let registering: Ed25519KeyPair | null = null
  let ktRowLock: Promise<unknown> = Promise.resolve()

  // MARK: - status and rows

  function status(): CryptoStatus {
    return {
      state,
      userId: init?.userId ?? null,
      deviceId: row?.deviceId ?? null,
      primary: row?.master?.privateKey != null,
      recoveryConfigured: row?.recoveryKeyId != null,
      hostTrust: ctx.platform === 'browser' ? 'server_code' : 'strong',
    }
  }
  const emitStatus = (): void => {
    ctx.emit('status', status())
  }

  function requireInit(): InitOptions {
    if (init === null) throw new CryptoError('NotInitialized', 'call init first')
    return init
  }
  function requireSelf(): SelfIdentity {
    if (self === null) throw new CryptoError('NoIdentity', 'this device has no identity')
    return self
  }
  function requireRow(): IdentityRow {
    if (row === null || self === null) throw new CryptoError('NoIdentity', 'this device has no identity')
    return row
  }
  function requireMaster(): { record: MasterKeyRecord; keyPair: Ed25519KeyPair } {
    const r = requireRow()
    const s = requireSelf()
    if (r.master?.privateKey == null) throw new CryptoError('Unsupported', 'only the primary device holds the master key')
    return { record: s.chain.master, keyPair: { publicKey: s.chain.master.publicKey, privateKey: r.master.privateKey } }
  }

  /** Decodes and cross-checks the stored chain. */
  function buildSelf(r: IdentityRow): SelfIdentity {
    if (r.master === null || r.dsk === null || r.deviceCertificate.length === 0) throw new CryptoError('StoreCorrupt', 'incomplete identity row')
    let chain: DeviceChain
    try {
      chain = {
        master: identity.decodeMasterKeyRecord(r.master.record),
        dsk: identity.decodeDskCert(r.dsk.cert),
        device: identity.decodeDeviceCertificate(r.deviceCertificate),
      }
    } catch {
      throw new CryptoError('StoreCorrupt', 'the stored chain does not decode')
    }
    const ok =
      chain.master.userId === r.userId &&
      chain.device.deviceId === r.deviceId &&
      verifyMasterSelfSignature(chain.master) &&
      verifyDskCert(chain.dsk, chain.master) &&
      verifyDeviceCert(chain.device, chain.dsk) &&
      equalBytes(chain.device.mlsSignatureKey, r.mlsSignatureKey.publicKey) &&
      equalBytes(chain.device.hpkeKey, r.hpkeKey.publicKey) &&
      keyPairMatches(r.dsk.privateKey, chain.dsk.publicKey) &&
      (r.master.privateKey === null || keyPairMatches(r.master.privateKey, chain.master.publicKey))
    if (!ok) throw new CryptoError('StoreCorrupt', 'the stored chain does not verify')
    rememberDsk(r.userId, chain.dsk)
    return { userId: r.userId, deviceId: r.deviceId, chain, mlsSignatureKey: r.mlsSignatureKey, hpkeKey: r.hpkeKey, primary: r.master.privateKey !== null }
  }

  async function saveRow(r: IdentityRow): Promise<void> {
    await store.put('identity', SELF, r)
    row = r
  }

  async function becomeReady(r: IdentityRow): Promise<void> {
    const s = buildSelf(r)
    await saveRow(r)
    self = s
    state = 'ready'
    keyCache.delete(r.userId)
    emitStatus()
  }

  /**
   * TOFU pin of the DS external sender, the KT key and ktRequired, per origin (§12.7.1, §12.14).
   * ktRequired is sticky: a later DsInfo with false does not turn KT off.
   */
  async function pinDs(r: IdentityRow): Promise<IdentityRow> {
    if (r.dsExternalSender !== null && r.ktPublicKey !== null && r.ktRequired != null) return r
    const info = await transport.getDsInfo()
    return {
      ...r,
      dsExternalSender: r.dsExternalSender ?? fromB64url(info.externalSender),
      ktPublicKey: r.ktPublicKey ?? fromB64url(info.ktPublicKey),
      ktRequired: r.ktRequired === true || info.ktRequired,
    }
  }

  /** The registered device without a certificate (first device, restore, reset or link). */
  async function pendingDevice(): Promise<IdentityRow> {
    const opts = requireInit()
    if (state === 'ready') throw new CryptoError('Unsupported', 'this device already has an identity')
    if (state === 'revoked') throw new CryptoError('DeviceRevoked', 'this device was revoked')
    if (row !== null) return row
    // The key comes first: POST /devices presents it and carries a device proof by it (§12.12).
    const mlsSignatureKey = generateEd25519()
    registering = mlsSignatureKey
    let device
    try {
      device = await transport.registerDevice({
        name: opts.deviceName,
        platform: opts.platform,
        clientVersion: opts.clientVersion,
        mlsSignatureKey: toB64url(mlsSignatureKey.publicKey),
      })
    } finally {
      registering = null
    }
    const hpkePrivate = x25519.utils.randomSecretKey()
    const pending: IdentityRow = {
      userId: opts.userId,
      deviceId: device.id,
      deviceCertificate: new Uint8Array(0),
      mlsSignatureKey,
      hpkeKey: { publicKey: x25519.getPublicKey(hpkePrivate), privateKey: hpkePrivate },
      dsk: null,
      master: null,
      recoveryKeyId: null,
      dsExternalSender: null,
      ktPublicKey: null,
      backupKey: null,
    }
    await saveRow(pending)
    // The UI thread sends X-Hachiman-Device from the status: the next calls (master key,
    // certificate, link) are device routes (§12.12).
    emitStatus()
    return pending
  }

  function certifySelf(r: IdentityRow, dsk: { cert: DeviceSigningKeyCert; keyPair: Ed25519KeyPair }): DeviceCertificate {
    return identity.certifyDevice(dsk, {
      deviceId: r.deviceId,
      mlsSignatureKey: r.mlsSignatureKey.publicKey,
      hpkeKey: r.hpkeKey.publicKey,
      issuedAtMs: ctx.now(),
      displayName: requireInit().deviceName,
    })
  }

  // MARK: - identity setup

  async function sealIdentityBackup(bk: BackupKeys, master: MasterKeyRecord, masterPrivate: Uint8Array, dsk: DeviceSigningKeyCert, dskPrivate: Uint8Array): Promise<void> {
    const blob = identity.sealBackup(bk, BackupKind.IDENTITY, identity.encodeIdentityBackup({ master, masterPrivateKey: masterPrivate, dskCert: dsk, dskPrivateKey: dskPrivate }))
    await transport.putIdentityBackup({ keyId: toB64url(bk.keyId), blob: toB64url(blob) })
  }

  async function createIdentity(mode: 'first' | 'reset'): Promise<{ recoveryKey: string; status: CryptoStatus }> {
    const opts = requireInit()
    const keys = await transport.getUserKeys(opts.userId)
    let r = await pendingDevice()
    const stored = r.master?.privateKey != null && r.dsk !== null
    if (!stored && keys.masterKey !== null) {
      throw new CryptoError('Unsupported', 'the account has a current master key: link this device or restore with the recovery key')
    }
    let master: { record: MasterKeyRecord; keyPair: Ed25519KeyPair }
    let dsk: { cert: DeviceSigningKeyCert; keyPair: Ed25519KeyPair }
    const keep = async (m: typeof master, d: typeof dsk): Promise<void> => {
      master = m
      dsk = d
      r = { ...r, master: { record: identity.encodeMasterKeyRecord(m.record), privateKey: m.keyPair.privateKey }, dsk: { cert: identity.encodeDskCert(d.cert), privateKey: d.keyPair.privateKey } }
      // Stored before the PUT, so a crash after it does not lose the master private key.
      await saveRow(r)
    }
    const fresh = async (generation: number): Promise<void> => {
      const m = identity.createMasterKey(opts.userId, generation, null)
      await keep(m, identity.createDeviceSigningKey(m, (keys.deviceSigningKey?.generation ?? 0) + 1))
    }
    if (stored) {
      // An earlier attempt made the keys and stopped before the end: continue with them.
      const record = identity.decodeMasterKeyRecord(r.master!.record)
      const cert = identity.decodeDskCert(r.dsk!.cert)
      master = { record, keyPair: { publicKey: record.publicKey, privateKey: r.master!.privateKey! } }
      dsk = { cert, keyPair: { publicKey: cert.publicKey, privateKey: r.dsk!.privateKey } }
    } else {
      await fresh(1)
    }
    r = await pinDs(r)
    await saveRow(r)
    const onServer = keys.masterKey !== null && equalBytes(fromB64url(keys.masterKey.record), identity.encodeMasterKeyRecord(master!.record))
    // After a password reset the DS accepts generation + 1 of the superseded record, and
    // UserKeys does not show that generation (no current master). The client counts up.
    for (let tries = 0; !onServer; tries++) {
      try {
        await transport.putMasterKey({ record: toB64url(identity.encodeMasterKeyRecord(master!.record)), dskCert: toB64url(identity.encodeDskCert(dsk!.cert)) })
        break
      } catch (e) {
        if (mode !== 'reset' || dsCodeOf(e) !== 'MasterKeyExists' || tries >= RESET_GENERATION_PROBES) throw e
        await fresh(master!.record.generation + 1)
      }
    }
    const cert = certifySelf(r, dsk!)
    await transport.putDeviceCertificate(r.deviceId, { certificate: toB64url(identity.encodeDeviceCertificate(cert)) })

    const rk = identity.generateRecoveryKey()
    const bk = identity.deriveBackupKeys(rk.bytes)
    if (mode === 'reset') await transport.deleteBackups()
    await sealIdentityBackup(bk, master!.record, master!.keyPair.privateKey, dsk!.cert, dsk!.keyPair.privateKey)
    await becomeReady({ ...r, deviceCertificate: identity.encodeDeviceCertificate(cert), recoveryKeyId: bk.keyId, backupKey: bk })
    await bestEffort(replenishKeyPackages())
    return { recoveryKey: rk.text, status: status() }
  }

  async function restoreFromRecoveryKey(text: string): Promise<CryptoStatus> {
    const opts = requireInit()
    const bk = identity.deriveBackupKeys(identity.parseRecoveryKey(text))
    // The backup routes need X-Hachiman-Device: register first.
    let r = await pendingDevice()
    const index = await transport.getBackups()
    if (index.keyId === null || !equalBytes(fromB64url(index.keyId), bk.keyId)) throw new CryptoError('WrongRecoveryKey', 'the backups use another recovery key')
    const item = index.items.find((i) => i.kind === 'identity')
    if (!item) throw new CryptoError('WrongRecoveryKey', 'no identity backup')
    const opened = identity.openBackup(bk, fromB64url((await transport.getBackup(item.id)).blob))
    if (opened.kind !== BackupKind.IDENTITY) throw new CryptoError('Malformed', 'the identity backup has another kind')
    let ib
    try {
      ib = identity.decodeIdentityBackup(opened.plaintext)
    } catch (e) {
      throw new CryptoError('Malformed', `identity backup: ${(e as Error).message}`)
    }
    const valid =
      ib.master.userId === opts.userId &&
      verifyMasterSelfSignature(ib.master) &&
      keyPairMatches(ib.masterPrivateKey, ib.master.publicKey) &&
      verifyDskCert(ib.dskCert, ib.master) &&
      keyPairMatches(ib.dskPrivateKey, ib.dskCert.publicKey)
    if (!valid) throw new CryptoError('InvalidChain', 'the identity backup does not verify')
    const master = { record: ib.master, keyPair: { publicKey: ib.master.publicKey, privateKey: ib.masterPrivateKey } }

    const keys = await transport.getUserKeys(opts.userId)
    const recordBytes = identity.encodeMasterKeyRecord(ib.master)
    // After a password reset there is no current master: the same record is PUT again (§12.12).
    const masterOnServer = keys.masterKey !== null && equalBytes(fromB64url(keys.masterKey.record), recordBytes)
    const serverDskGen = keys.deviceSigningKey?.generation ?? 0
    let dsk = { cert: ib.dskCert, keyPair: { publicKey: ib.dskCert.publicKey, privateKey: ib.dskPrivateKey } }
    const staleDsk = dsk.cert.generation < serverDskGen
    if (staleDsk) dsk = identity.createDeviceSigningKey(master, serverDskGen + 1)

    r = await pinDs({ ...r, master: { record: recordBytes, privateKey: master.keyPair.privateKey }, dsk: { cert: identity.encodeDskCert(dsk.cert), privateKey: dsk.keyPair.privateKey } })
    await saveRow(r)
    if (!masterOnServer) await transport.putMasterKey({ record: toB64url(recordBytes), dskCert: toB64url(identity.encodeDskCert(dsk.cert)) })
    else if (staleDsk) await transport.putDeviceSigningKey({ cert: toB64url(identity.encodeDskCert(dsk.cert)) })
    const cert = certifySelf(r, dsk)
    await transport.putDeviceCertificate(r.deviceId, { certificate: toB64url(identity.encodeDeviceCertificate(cert)) })
    await becomeReady({ ...r, deviceCertificate: identity.encodeDeviceCertificate(cert), recoveryKeyId: bk.keyId, backupKey: bk })

    if (staleDsk) {
      await sealIdentityBackup(bk, master.record, master.keyPair.privateKey, dsk.cert, dsk.keyPair.privateKey)
      if (masterOnServer) await recertifyOthers(dsk, new Set())
    }
    for (const h of index.items.filter((i) => i.kind === 'history')) {
      await bestEffort(
        (async () => {
          const b = identity.openBackup(bk, fromB64url((await transport.getBackup(h.id)).blob))
          if (b.kind !== BackupKind.HISTORY) throw new CryptoError('Malformed', 'history backup of another kind')
          await importEpochSecrets(ctx, identity.decodeHistoryBatch(b.plaintext), true)
        })(),
      )
    }
    await bestEffort(replenishKeyPackages())
    return status()
  }

  async function rotateRecoveryKey(): Promise<{ recoveryKey: string }> {
    const master = requireMaster()
    const r = requireRow()
    const s = requireSelf()
    if (r.dsk === null) throw new CryptoError('NoIdentity', 'no device-signing key')
    // §12.11.3: the new key is stored before the first upload, and a later call after a failure
    // (crash, network error, 429) continues with it. The key is returned only after every upload.
    let text = r.pendingRecoveryKey ?? null
    if (text === null) {
      text = identity.generateRecoveryKey().text
      await saveRow({ ...r, pendingRecoveryKey: text })
    }
    const bk = identity.deriveBackupKeys(identity.parseRecoveryKey(text))
    const secrets = await store.list('epochSecrets')
    const batches = historyBatches(secrets.map((x) => x.value)).map((b) => ({ ...b, blob: identity.sealBackup(bk, BackupKind.HISTORY, identity.encodeHistoryBatch(b.entries)) }))
    // The DS keeps one identity blob and one key id per user, and DELETE /backups removes every
    // blob: it runs before the uploads under the new key id. Until they finish, this device holds
    // every key and the pending recovery key, so a retry restores the backups.
    await transport.deleteBackups()
    await sealIdentityBackup(bk, master.record, master.keyPair.privateKey, s.chain.dsk, r.dsk.privateKey)
    for (const b of batches) {
      await transport.postHistoryBackup({ keyId: toB64url(bk.keyId), groupId: toB64url(b.groupId), epochFrom: b.epochFrom, epochTo: b.epochTo, blob: toB64url(b.blob) })
    }
    await markEpochSecretsBackedUp(store, secrets.map((x) => x.value))
    await saveRow({ ...requireRow(), recoveryKeyId: bk.keyId, backupKey: bk, pendingRecoveryKey: null })
    emitStatus()
    return { recoveryKey: text }
  }

  // MARK: - history keys and backups

  function historyBatches(entries: readonly HistoryKeyEntry[]): { groupId: Uint8Array; epochFrom: number; epochTo: number; entries: HistoryKeyEntry[] }[] {
    const out: { groupId: Uint8Array; epochFrom: number; epochTo: number; entries: HistoryKeyEntry[] }[] = []
    for (const g of groupHistory(entries)) {
      for (let i = 0; i < g.keys.length; i += BACKUP_BATCH_KEYS) {
        const keys = g.keys.slice(i, i + BACKUP_BATCH_KEYS)
        out.push({ groupId: g.groupId, epochFrom: keys[0]!.epoch, epochTo: keys[keys.length - 1]!.epoch, entries: keys.map((k) => ({ groupId: g.groupId, ...k })) })
      }
    }
    return out
  }

  async function exportHistory(): Promise<HistoryKeyEntry[]> {
    const all = (await store.list('epochSecrets')).map((x) => ({ groupId: x.value.groupId, epoch: x.value.epoch, secret: x.value.secret }))
    return groupHistory(all).flatMap((g) => g.keys.slice(-HISTORY_BUNDLE_MAX_EPOCHS).map((k) => ({ groupId: g.groupId, ...k })))
  }

  async function backupNow(): Promise<{ uploaded: number }> {
    const r = requireRow()
    const bk = r.backupKey
    // A recovery key rotation in progress uploads every key under the new key id itself.
    if (bk === null || r.pendingRecoveryKey != null) return { uploaded: 0 }
    const pending = (await store.list('epochSecrets')).map((x) => x.value).filter((v) => !v.backedUp)
    let uploaded = 0
    const now = ctx.now()
    for (const g of groupHistory(pending)) {
      const gk = groupKey(g.groupId)
      const last = lastHistoryBackup.get(gk)
      if (g.keys.length < BACKUP_EPOCH_THRESHOLD && last !== undefined && now - last < BACKUP_INTERVAL_MS) continue
      for (const b of historyBatches(g.keys.map((k) => ({ groupId: g.groupId, ...k })))) {
        const blob = identity.sealBackup(bk, BackupKind.HISTORY, identity.encodeHistoryBatch(b.entries))
        await transport.postHistoryBackup({ keyId: toB64url(bk.keyId), groupId: gk, epochFrom: b.epochFrom, epochTo: b.epochTo, blob: toB64url(blob) })
        await markEpochSecretsBackedUp(store, b.entries)
        uploaded++
      }
      lastHistoryBackup.set(gk, now)
    }
    return { uploaded }
  }

  // MARK: - user keys, TOFU, chain contexts

  function rememberDsk(userId: UserId, dsk: DeviceSigningKeyCert): void {
    let m = knownDsks.get(userId)
    if (!m) knownDsks.set(userId, (m = new Map<number, Uint8Array>()))
    m.set(dsk.generation, dsk.publicKey)
  }

  const ktClient = createKtClient({
    transport,
    ktPublicKey: () => row?.ktPublicKey ?? null,
    ktRequired: () => row?.ktRequired === true,
    loadState: () => store.get('kt', SELF),
    patchState: (patch) => patchKtRow(patch),
    alert: (a) => {
      ctx.emit('ktAlert', a)
    },
    now: () => ctx.now(),
  })

  function patchKtRow(patch: Partial<StoreSchema['kt']>): Promise<void> {
    const next = ktRowLock.then(async () => {
      const cur = (await store.get('kt', SELF)) ?? { treeHead: null, lastSelfCheckMs: 0, lastSelfIndex: -1 }
      await store.put('kt', SELF, { ...cur, ...patch })
    })
    ktRowLock = next.catch(() => undefined)
    return next
  }

  /**
   * Phase 4: the inclusion proof of one key object. Fails closed when the pinned DsInfo requires
   * KT or a head is stored. Only a DS that never advertised KT (and sent no head) skips the proof.
   */
  async function proveKt(userId: UserId, type: KtEntry['type'], object: Uint8Array, ktIndex: number | null, ktEntry: string | null): Promise<void> {
    if (ktIndex === null || ktEntry === null) {
      if (await ktClient.active()) {
        ctx.emit('ktAlert', { kind: 'kt_missing', detail: `a key object of ${userId} has no KT entry` })
        throw new CryptoError('InvalidChain', 'key object without a KT entry')
      }
      return
    }
    await ktClient.prove(ktIndex, fromB64url(ktEntry), { type, userId, object })
  }

  async function fetchKeys(userId: UserId): Promise<VerifiedKeys | null> {
    let wire: Awaited<ReturnType<typeof transport.getUserKeys>>
    try {
      wire = await transport.getUserKeys(userId)
    } catch (e) {
      // 404: no shared guild or DM any more (a former member whose leaf waits for its Remove).
      // No keys, as for a user without a master key: a new leaf of the user fails the chain check.
      if (dsCodeOf(e) === 'NotFound') return null
      throw e
    }
    if (wire.userId !== userId) throw new CryptoError('InvalidChain', 'the DS answered for another user')
    if (wire.masterKey === null) return null
    const recordBytes = fromB64url(wire.masterKey.record)
    const served = identity.decodeMasterKeyRecord(recordBytes)
    if (served.userId !== userId || !verifyMasterSelfSignature(served)) throw new CryptoError('InvalidChain', 'bad master key record')
    await proveKt(userId, KtEntryType.MASTER_KEY, recordBytes, wire.masterKey.ktIndex, wire.masterKey.ktEntry)

    const isSelf = self !== null && userId === self.userId
    let master = served
    let masterMismatch = false
    if (isSelf) {
      const own = self!.chain.master
      if (!equalBytes(identity.encodeMasterKeyRecord(own), recordBytes)) {
        masterMismatch = true
        master = own
        ctx.emit('keyChange', { userId, severity: 'blocking' })
      }
    }

    let dsk: DeviceSigningKeyCert | null = null
    if (wire.deviceSigningKey !== null && !masterMismatch) {
      const certBytes = fromB64url(wire.deviceSigningKey.cert)
      const c = identity.decodeDskCert(certBytes)
      if (!verifyDskCert(c, master)) throw new CryptoError('InvalidChain', 'bad device-signing key cert')
      await proveKt(userId, KtEntryType.DEVICE_SIGNING_KEY, certBytes, wire.deviceSigningKey.ktIndex, wire.deviceSigningKey.ktEntry)
      dsk = c
      rememberDsk(userId, c)
    }

    const certs = new Map<DeviceId, DeviceCertificate>()
    const revoked = new Set<DeviceId>()
    const dsks = knownDsks.get(userId)
    for (const d of wire.devices) {
      let cert: DeviceCertificate | null = null
      if (d.certificate !== null && !masterMismatch) {
        try {
          const bytes = fromB64url(d.certificate)
          const c = identity.decodeDeviceCertificate(bytes)
          const signer = dsks?.get(c.dskGeneration)
          if (c.userId === userId && c.deviceId === d.id && signer !== undefined && verifyDeviceCert(c, { userId, generation: c.dskGeneration, publicKey: signer })) {
            if (d.status !== 'revoked') await proveKt(userId, KtEntryType.DEVICE_CERTIFICATE, bytes, d.ktIndex, d.ktEntry)
            cert = c
          }
        } catch (e) {
          if (e instanceof CryptoError && e.code === 'InvalidChain') throw e
          cert = null
        }
      }
      if (cert !== null) certs.set(d.id, cert)
      if (d.status === 'revoked') revoked.add(d.id)
      else if (d.revocation !== null) {
        try {
          if (identity.verifyRevocation(identity.decodeRevocation(fromB64url(d.revocation)), { master, device: cert })) revoked.add(d.id)
        } catch {
          // A revocation that does not decode revokes nothing. The DS status still applies.
        }
      }
    }
    const pendingChange = !isSelf && (await updateContact(userId, master, dsk))
    return { userId, fetchedAtMs: ctx.now(), master, dsk, certs, revoked, masterMismatch, pendingChange }
  }

  /**
   * TOFU (§12.5) and the rule 9 DSK generation record. A served master that is not the pin and
   * not a valid prev_signature rotation of it does not replace the pin: it is stored as the
   * candidate (trust 'changed') until acknowledgeKeyChange or a new verification. Returns true
   * while such a change is pending.
   */
  async function updateContact(userId: UserId, master: MasterKeyRecord, dsk: DeviceSigningKeyCert | null): Promise<boolean> {
    const dskGen = dsk?.generation ?? 0
    const c = await store.get('contacts', userId)
    if (!c) {
      await store.put('contacts', userId, { userId, masterKey: master.publicKey, generation: master.generation, dskGeneration: dskGen, trust: 'tofu', changedAtMs: null, candidate: null })
      return false
    }
    if (!equalBytes(c.masterKey, master.publicKey) || c.generation !== master.generation) {
      const continued =
        master.prevSignature !== null && master.generation === c.generation + 1 && identity.verifyMasterKeyRecord(master, c.masterKey)
      if (continued) {
        await store.put('contacts', userId, { ...c, masterKey: master.publicKey, generation: master.generation, dskGeneration: Math.max(c.dskGeneration, dskGen) })
        return c.trust === 'changed'
      }
      const cand = c.candidate ?? null
      if (c.trust === 'changed' && cand !== null && equalBytes(cand.masterKey, master.publicKey) && cand.generation === master.generation) return true
      ctx.emit('keyChange', { userId, severity: c.trust === 'verified' ? 'blocking' : 'notice' })
      await store.put('contacts', userId, { ...c, trust: 'changed', changedAtMs: ctx.now(), candidate: { masterKey: master.publicKey, generation: master.generation }, verifiedAtMs: null })
      return true
    }
    if (dskGen < c.dskGeneration) {
      // Rule 9: keep the higher value, so verifyChain gives 'dsk_downgrade'.
      ctx.emit('keyChange', { userId, severity: c.trust === 'verified' ? 'blocking' : 'notice' })
    } else if (dskGen > c.dskGeneration) {
      await store.put('contacts', userId, { ...c, dskGeneration: dskGen })
    }
    return c.trust === 'changed'
  }

  /** Makes the candidate of a key change the pin. The next fetch checks the user's keys against it. */
  async function adoptCandidate(c: StoreSchema['contacts'], trust: 'tofu' | 'verified'): Promise<StoreSchema['contacts']> {
    const cand = c.candidate ?? null
    const verifiedAtMs = trust === 'verified' ? ctx.now() : null
    // A new master starts its own DSK generations: the rule 9 record of the old one does not apply.
    const next: StoreSchema['contacts'] =
      cand === null
        ? { ...c, trust, changedAtMs: null, candidate: null, verifiedAtMs }
        : { ...c, masterKey: cand.masterKey, generation: cand.generation, dskGeneration: 0, trust, changedAtMs: null, candidate: null, verifiedAtMs }
    await store.put('contacts', c.userId, next)
    keyCache.delete(c.userId)
    return next
  }

  function userKeys(userId: UserId, fresh = false): Promise<VerifiedKeys | null> {
    const hit = keyCache.get(userId)
    if (!fresh && hit && ctx.now() - hit.at < USER_KEYS_TTL_MS) return hit.value
    const value = fetchKeys(userId)
    keyCache.set(userId, { at: ctx.now(), value })
    value.catch(() => {
      if (keyCache.get(userId)?.value === value) keyCache.delete(userId)
    })
    return value
  }

  async function chainContextFor(userId: UserId, entering: boolean): Promise<ChainContext> {
    const keys = await userKeys(userId)
    const nowMs = ctx.now()
    if (keys === null) {
      return { pinnedMaster: null, currentDsk: null, highestSeenDskGeneration: null, revokedDeviceIds: new Set(), leaf: null, entering, nowMs }
    }
    const currentDsk = keys.dsk === null ? null : { generation: keys.dsk.generation, issuedAtMs: keys.dsk.issuedAtMs }
    if (self !== null && userId === self.userId) {
      return {
        pinnedMaster: { publicKey: self.chain.master.publicKey, generation: self.chain.master.generation },
        currentDsk,
        highestSeenDskGeneration: self.chain.dsk.generation,
        revokedDeviceIds: keys.revoked,
        leaf: null,
        entering,
        nowMs,
      }
    }
    const c = await store.get('contacts', userId)
    // A pending key change: the old pin stays, and no current DSK is known under it. A chain of the
    // new master gives 'master_changed', a chain of the old one 'dsk_superseded' (fail closed).
    const pending = keys.pendingChange || c?.trust === 'changed'
    return {
      pinnedMaster: c ? { publicKey: c.masterKey, generation: c.generation } : null,
      currentDsk: pending ? null : currentDsk,
      highestSeenDskGeneration: c?.dskGeneration ?? null,
      revokedDeviceIds: keys.revoked,
      leaf: null,
      entering,
      nowMs,
    }
  }

  /** userKeys(userId, true), unless the cached value is younger than KEY_REFRESH_MIN_MS. */
  function refreshKeys(userId: UserId): Promise<VerifiedKeys | null> {
    const hit = keyCache.get(userId)
    if (hit && ctx.now() - hit.at < KEY_REFRESH_MIN_MS) return hit.value
    return userKeys(userId, true)
  }

  async function deviceCertificate(userId: UserId, deviceId: DeviceId): Promise<DeviceCertificate | null> {
    let keys = await userKeys(userId)
    if (keys !== null && !keys.certs.has(deviceId)) keys = await refreshKeys(userId)
    return keys?.certs.get(deviceId) ?? null
  }

  async function deviceOwnerCertificate(deviceId: DeviceId, hintUserId: UserId): Promise<DeviceCertificate | null> {
    const hinted = (await userKeys(hintUserId))?.certs.get(deviceId)
    if (hinted !== undefined) return hinted
    // Keys of other users that this Worker already fetched and verified (group members, contacts).
    for (const [userId, entry] of [...keyCache]) {
      if (userId === hintUserId) continue
      const cert = (await entry.value.catch(() => null))?.certs.get(deviceId)
      if (cert !== undefined) return cert
    }
    return (await refreshKeys(hintUserId))?.certs.get(deviceId) ?? null
  }

  async function listContactDevices(userId: UserId): Promise<ContactDevice[]> {
    const keys = await userKeys(userId)
    if (keys === null || keys.masterMismatch || keys.pendingChange) return []
    return [...keys.certs.values()]
      .filter((c) => !keys.revoked.has(c.deviceId))
      .sort((a, b) => a.issuedAtMs - b.issuedAtMs || (a.deviceId < b.deviceId ? -1 : 1))
      .map((c) => ({ deviceId: c.deviceId, displayName: c.displayName, dskGeneration: c.dskGeneration, issuedAtMs: c.issuedAtMs }))
  }

  async function trustOf(userId: UserId): Promise<SenderTrust> {
    if (self !== null && userId === self.userId) return 'verified'
    return (await store.get('contacts', userId))?.trust ?? 'unknown'
  }

  async function trustInfo(userId: UserId): Promise<TrustInfo> {
    if (self !== null && userId === self.userId) {
      return { userId, state: 'verified', masterKeyGeneration: self.chain.master.generation, changedAt: null, verifiedAt: null }
    }
    const c = await store.get('contacts', userId)
    return {
      userId,
      state: c?.trust ?? 'unknown',
      masterKeyGeneration: c?.generation ?? null,
      changedAt: c?.changedAtMs == null ? null : new Date(c.changedAtMs).toISOString(),
      verifiedAt: c?.trust !== 'verified' || c.verifiedAtMs == null ? null : new Date(c.verifiedAtMs).toISOString(),
    }
  }

  async function requireContact(userId: UserId): Promise<StoreSchema['contacts']> {
    await userKeys(userId)
    const c = await store.get('contacts', userId)
    if (!c) throw new CryptoError('InvalidChain', 'the user has no identity')
    return c
  }

  // MARK: - key packages

  async function replenishKeyPackages(): Promise<void> {
    if (replenishing) return replenishing
    replenishing = (async () => {
      const s = requireSelf()
      const keys = await userKeys(s.userId, true)
      // Wait for the dsk_transfer: packages with a superseded chain would be deleted at once.
      if (keys?.dsk && keys.dsk.generation > s.chain.dsk.generation) return
      const info = await transport.getDsInfo()
      const target = info.limits.keyPackageTarget > 0 ? info.limits.keyPackageTarget : KEY_PACKAGE_TARGET
      const counts = await transport.countKeyPackages()
      for (const suite of info.cipherSuites.filter((x) => SUPPORTED_SUITES.includes(x))) {
        const c = counts.find((x) => x.cipherSuite === suite)
        let need = Math.max(0, target - (c?.count ?? 0))
        let lastResort = !(c?.lastResort ?? false)
        while (need > 0 || lastResort) {
          const n = Math.min(need, MAX_UPLOAD_PER_CALL)
          const oneTime = n > 0 ? await deps.mls.generateKeyPackages({ chain: s.chain, signatureKey: s.mlsSignatureKey, cipherSuite: suite, count: n, lastResort: false }) : []
          const lr = lastResort ? await deps.mls.generateKeyPackages({ chain: s.chain, signatureKey: s.mlsSignatureKey, cipherSuite: suite, count: 1, lastResort: true }) : []
          const now = ctx.now()
          for (const [list, isLr] of [[oneTime, false], [lr, true]] as const) {
            for (const kp of list) {
              await store.put('keyPackages', toB64url(kp.ref), { ref: kp.ref, cipherSuite: suite, publicPackage: kp.publicPackage, privatePackage: kp.privatePackage, lastResort: isLr, createdAtMs: now })
            }
          }
          await transport.uploadKeyPackages({ cipherSuite: suite, keyPackages: oneTime.map((k) => toB64url(k.publicPackage)), lastResort: lr[0] ? toB64url(lr[0].publicPackage) : null })
          need -= n
          lastResort = false
        }
      }
      const cutoff = ctx.now() - KEY_PACKAGE_LIFETIME_MS
      for (const { key, value } of await store.list('keyPackages')) if (value.createdAtMs < cutoff) await store.delete('keyPackages', key)
    })()
    try {
      await replenishing
    } finally {
      replenishing = null
    }
  }

  // MARK: - devices, revocation, DSK rotation

  /** Certifies the other active devices under `dsk` and sends each one a dsk_transfer (§12.4). */
  async function recertifyOthers(dsk: { cert: DeviceSigningKeyCert; keyPair: Ed25519KeyPair }, exclude: ReadonlySet<DeviceId>): Promise<void> {
    const s = requireSelf()
    for (const d of await transport.listOwnDevices()) {
      if (d.id === s.deviceId || exclude.has(d.id) || d.status !== 'active' || d.certificate === null) continue
      let old: DeviceCertificate
      try {
        old = identity.decodeDeviceCertificate(fromB64url(d.certificate))
      } catch {
        continue
      }
      if (old.userId !== s.userId || old.deviceId !== d.id) continue
      const cert = identity.certifyDevice(dsk, { deviceId: d.id, mlsSignatureKey: old.mlsSignatureKey, hpkeKey: old.hpkeKey, issuedAtMs: ctx.now(), displayName: old.displayName })
      await transport.putDeviceCertificate(d.id, { certificate: toB64url(identity.encodeDeviceCertificate(cert)) })
      const sealed = await sealDeviceMessage({
        recipientHpkeKey: old.hpkeKey,
        recipientDeviceId: d.id,
        kind: 'dsk_transfer',
        senderDeviceId: s.deviceId,
        signatureKey: s.mlsSignatureKey.privateKey,
        payload: encodeDskTransfer({ dsk: dsk.cert, dskPrivateKey: dsk.keyPair.privateKey, device: cert }),
      })
      await transport.postInbox(d.id, { kind: 'dsk_transfer', body: toB64url(sealed) })
    }
  }

  async function rotateDsk(exclude: ReadonlySet<DeviceId>): Promise<void> {
    const master = requireMaster()
    const s = requireSelf()
    const r = requireRow()
    const keys = await transport.getUserKeys(s.userId)
    const dsk = identity.createDeviceSigningKey(master, Math.max(keys.deviceSigningKey?.generation ?? 0, s.chain.dsk.generation) + 1)
    await transport.putDeviceSigningKey({ cert: toB64url(identity.encodeDskCert(dsk.cert)) })
    const cert = certifySelf(r, dsk)
    const next: IdentityRow = { ...r, dsk: { cert: identity.encodeDskCert(dsk.cert), privateKey: dsk.keyPair.privateKey }, deviceCertificate: identity.encodeDeviceCertificate(cert) }
    await becomeReady(next)
    await transport.putDeviceCertificate(s.deviceId, { certificate: toB64url(identity.encodeDeviceCertificate(cert)) })
    await recertifyOthers(dsk, exclude)
    if (next.backupKey) await sealIdentityBackup(next.backupKey, master.record, master.keyPair.privateKey, dsk.cert, dsk.keyPair.privateKey)
    fireDskRotated()
    await bestEffort(replenishKeyPackages())
  }

  function fireDskRotated(): void {
    for (const cb of dskListeners) {
      try {
        cb()
      } catch (e) {
        reportError(e)
      }
    }
  }

  async function handleInboxItem(item: WireInboxItem): Promise<void> {
    if (item.kind !== 'dsk_transfer') return
    const s = requireSelf()
    const r = requireRow()
    keyCache.delete(s.userId)
    const opened = await openDeviceMessage({
      recipientHpkePrivateKey: s.hpkeKey.privateKey,
      recipientDeviceId: s.deviceId,
      sealed: fromB64url(item.body),
      senderSignatureKey: async (sender, kind) => {
        if (kind !== 'dsk_transfer' || sender === s.deviceId || (item.senderDevice !== null && item.senderDevice !== sender)) return null
        const keys = await userKeys(s.userId)
        if (keys === null || keys.masterMismatch || keys.revoked.has(sender)) return null
        return keys.certs.get(sender)?.mlsSignatureKey ?? null
      },
    })
    let t
    try {
      t = decodeDskTransfer(opened.payload)
    } catch (e) {
      throw new CryptoError('Malformed', `dsk_transfer: ${(e as Error).message}`)
    }
    // A replayed or older transfer has no effect (§12.4).
    if (t.dsk.generation <= s.chain.dsk.generation) return
    const valid =
      verifyDskCert(t.dsk, s.chain.master) &&
      keyPairMatches(t.dskPrivateKey, t.dsk.publicKey) &&
      t.device.deviceId === s.deviceId &&
      equalBytes(t.device.mlsSignatureKey, s.mlsSignatureKey.publicKey) &&
      equalBytes(t.device.hpkeKey, s.hpkeKey.publicKey) &&
      verifyDeviceCert(t.device, t.dsk)
    if (!valid) throw new CryptoError('InvalidChain', 'the dsk_transfer does not verify under the own master key')
    await becomeReady({ ...r, dsk: { cert: identity.encodeDskCert(t.dsk), privateKey: t.dskPrivateKey }, deviceCertificate: identity.encodeDeviceCertificate(t.device) })
    await bestEffort(replenishKeyPackages())
    fireDskRotated()
  }

  async function listDevices(): Promise<DeviceSummary[]> {
    const s = requireSelf()
    return (await transport.listOwnDevices()).map((d) => ({
      id: d.id,
      // The REST name: the own device list is the one place that shows it (§12.5).
      name: d.name,
      platform: d.platform,
      status: d.status,
      current: d.id === s.deviceId,
      primary: d.id === s.deviceId && s.primary,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    }))
  }

  async function revokeDevice(deviceId: DeviceId, reason: Exclude<RevocationReasonName, 'password_reset' | 'signed_out'>): Promise<void> {
    const master = requireMaster()
    const s = requireSelf()
    if (deviceId === s.deviceId) throw new CryptoError('Unsupported', 'sign out to remove this device')
    // The reason crosses the Worker boundary: check it at run time too.
    const reasonId = (REASON_ID as Partial<Record<string, 1 | 2 | 4>>)[reason]
    if (reasonId === undefined) throw new CryptoError('Unsupported', `reason ${reason}`)
    const revocation = identity.revoke(master, deviceId, reasonId, ctx.now())
    await transport.revokeDevice(deviceId, { revocation: toB64url(identity.encodeRevocation(revocation)), reason })
    keyCache.delete(s.userId)
    await rotateDsk(new Set([deviceId]))
  }

  /**
   * This device is revoked on the DS. Only a revocation that verifies (master-signed, or a
   * signed_out by this device) erases the store. An unsigned one (password_reset: the server, or
   * whoever can reset the password) locks the device and keeps the identity and epoch secrets, so
   * the user can still save them; signOutDevice is the explicit wipe.
   */
  async function onSelfRevoked(me: { revocation: string | null } | null): Promise<void> {
    const s = requireSelf()
    let signed = false
    if (me?.revocation != null) {
      try {
        const rev = identity.decodeRevocation(fromB64url(me.revocation))
        signed = rev.deviceId === s.deviceId && identity.verifyRevocation(rev, { master: s.chain.master, device: s.chain.device })
      } catch {
        signed = false
      }
    }
    if (signed) {
      await forget()
      return
    }
    await lock(requireRow())
  }

  async function lock(r: IdentityRow): Promise<void> {
    await markLocked(r)
    emitStatus()
  }

  /** lock without the status event (the start-up check: the start result reports it). */
  async function markLocked(r: IdentityRow): Promise<void> {
    if (r.lockedAtMs == null) await saveRow({ ...r, lockedAtMs: ctx.now() })
    self = null
    keyCache.clear()
    state = 'revoked'
  }

  async function signOutDevice(): Promise<void> {
    if (row === null) throw new CryptoError('NoIdentity', 'this device has no identity')
    const r = row
    const locked = r.lockedAtMs != null
    // signed_out verifies under the device certificate on the DS. A pending device has none and
    // signs out unsigned. A locked device was revoked already, or is half-linked (lockIfUnusable):
    // active on the DS with a certificate for this MLS key, though this store never got it.
    let revocation: string | null = null
    if (locked || self !== null) {
      const masterGeneration = r.master ? identity.decodeMasterKeyRecord(r.master.record).generation : 0
      revocation = toB64url(identity.encodeRevocation(identity.signOut({ userId: r.userId, deviceId: r.deviceId, masterGeneration, mlsSignatureKey: r.mlsSignatureKey }, ctx.now())))
    }
    try {
      await transport.revokeDevice(r.deviceId, { revocation, reason: 'signed_out' })
    } catch (e) {
      // A revoked device cannot sign out again on the DS. A pending device has no keys to keep,
      // and the DS may not know it (a store from another server). Both stores go anyway. An
      // active device keeps its store, so no active device is left that no store holds.
      if (!locked && self !== null) throw e
    }
    await forget()
  }

  // MARK: - device proof (§12.12, §12.13)

  function proveDevice(input: DeviceProofInput): Promise<DeviceProof> {
    if (typeof input !== 'object' || input === null || (input.kind !== 'ds' && input.kind !== 'identify')) {
      return Promise.reject(new CryptoError('Malformed', 'device proof input'))
    }
    const key = row?.mlsSignatureKey ?? registering
    if (!key) return Promise.reject(new CryptoError('NoIdentity', 'this device has no MLS key'))
    const deviceId = row?.deviceId ?? ''
    const ts = ctx.now()
    const nonce = toB64url(ctx.random(DEVICE_PROOF_NONCE_BYTES))
    let message: Uint8Array
    try {
      message = deviceProofMessage(input, deviceId, ts, nonce)
    } catch (e) {
      return Promise.reject(new CryptoError('Malformed', (e as Error).message))
    }
    return Promise.resolve({ ts, nonce, sig: toB64url(ed25519.sign(message, key.privateKey)) })
  }

  async function forget(): Promise<void> {
    await store.destroy()
    row = null
    self = null
    keyCache.clear()
    state = 'revoked'
    emitStatus()
  }

  // MARK: - key transparency self-check (§12.14)

  async function ktSelfCheck(): Promise<KtSelfCheckResult> {
    const s = requireSelf()
    const kts = (await store.get('kt', SELF)) ?? { treeHead: null, lastSelfCheckMs: 0, lastSelfIndex: -1 }
    const head = await ktClient.storedHead()
    const ownMaster = identity.encodeMasterKeyRecord(s.chain.master)
    const own = await userKeys(s.userId, true)
    const ownDevices = await transport.listOwnDevices()
    const dsks = new Map<number, Uint8Array>(knownDsks.get(s.userId) ?? [])
    const deviceKeys = new Map<DeviceId, Uint8Array>()
    for (const [id, c] of own?.certs ?? []) deviceKeys.set(id, c.mlsSignatureKey)

    const entries: { index: number; entry: KtEntry }[] = []
    let after = kts.lastSelfIndex
    for (;;) {
      const page = await transport.ktEntries({ userId: s.userId, after })
      if (page.length === 0) break
      for (const w of page) {
        if (w.index <= after) throw new CryptoError('Malformed', 'KT entries out of order')
        after = w.index
        try {
          entries.push({ index: w.index, entry: ktDecode(w.entry) })
        } catch {
          entries.push({ index: w.index, entry: { type: w.type, userId: s.userId, timestampMs: 0, object: new Uint8Array(0) } })
        }
      }
    }
    let start = 0
    if (kts.lastSelfIndex < 0) {
      // First check on this device: entries before the own master record belong to an older identity.
      const first = entries.findIndex((e) => e.entry.type === KtEntryType.MASTER_KEY && equalBytes(e.entry.object, ownMaster))
      if (first > 0) start = first
    }
    const unknownEntries: KtSelfCheckResult['unknownEntries'] = []
    for (const { index, entry } of entries.slice(start)) {
      const verdict = ownEntry(entry, s, ownMaster, dsks, deviceKeys, ownDevices)
      if (!verdict.ok) unknownEntries.push({ index, type: entry.type, deviceId: verdict.deviceId })
    }
    for (const u of unknownEntries) ctx.emit('ktAlert', { kind: 'self_unknown_entry', detail: `KT entry ${u.index} (type ${u.type}) was not made by an own device` })
    await patchKtRow({ lastSelfCheckMs: ctx.now(), lastSelfIndex: after })
    return { ok: unknownEntries.length === 0, treeSize: head?.treeSize ?? 0, unknownEntries }
  }

  function ktDecode(b64: string): KtEntry {
    return ktModule.decodeEntry(fromB64url(b64))
  }

  /** Does the entry hold an object that the own master key chain signed? */
  function ownEntry(
    e: KtEntry,
    s: SelfIdentity,
    ownMaster: Uint8Array,
    dsks: Map<number, Uint8Array>,
    deviceKeys: Map<DeviceId, Uint8Array>,
    ownDevices: Awaited<ReturnType<typeof transport.listOwnDevices>>,
  ): { ok: boolean; deviceId: DeviceId | null } {
    if (e.userId !== s.userId) return { ok: false, deviceId: null }
    try {
      switch (e.type) {
        case KtEntryType.MASTER_KEY:
          return { ok: equalBytes(e.object, ownMaster), deviceId: null }
        case KtEntryType.DEVICE_SIGNING_KEY: {
          const c = identity.decodeDskCert(e.object)
          const ok = verifyDskCert(c, s.chain.master)
          if (ok) dsks.set(c.generation, c.publicKey)
          return { ok, deviceId: null }
        }
        case KtEntryType.DEVICE_CERTIFICATE: {
          const c = identity.decodeDeviceCertificate(e.object)
          const signer = dsks.get(c.dskGeneration)
          const ok = signer !== undefined && verifyDeviceCert(c, { userId: s.userId, generation: c.dskGeneration, publicKey: signer })
          if (ok) deviceKeys.set(c.deviceId, c.mlsSignatureKey)
          return { ok, deviceId: c.deviceId }
        }
        case KtEntryType.DEVICE_REVOCATION: {
          const rev = identity.decodeRevocation(e.object)
          let device: DeviceCertificate | null = null
          const key = deviceKeys.get(rev.deviceId)
          const wire = ownDevices.find((d) => d.id === rev.deviceId)
          if (wire?.certificate) {
            const c = identity.decodeDeviceCertificate(fromB64url(wire.certificate))
            if (key !== undefined && equalBytes(c.mlsSignatureKey, key)) device = c
          }
          return { ok: identity.verifyRevocation(rev, { master: s.chain.master, device }), deviceId: rev.deviceId }
        }
      }
    } catch {
      return { ok: false, deviceId: null }
    }
  }

  // MARK: - signed admin actions (§12.16)

  async function adminState(guildId: string): Promise<AdminReplayState | null> {
    requireSelf()
    const cached = (await store.get('adminState', guildId)) ?? null
    const actions: AdminAction[] = []
    let after = cached?.seq ?? -1
    for (;;) {
      const page = await transport.adminActions(guildId, after)
      if (page.length === 0) break
      for (const w of page) {
        if (w.seq <= after || w.guildId !== guildId) throw new CryptoError('Malformed', 'admin actions out of order')
        const a = adminModule.decodeAction(fromB64url(w.action))
        if (a.seq !== w.seq || a.guildId !== guildId) throw new CryptoError('Malformed', `admin action ${w.seq} does not match its row`)
        actions.push(a)
        after = w.seq
      }
    }
    if (actions.length === 0) return cached
    const certs = new Map<string, DeviceCertificate | null>()
    for (const a of actions) {
      const k = `${a.actorUserId}:${a.actorDeviceId}`
      if (!certs.has(k)) certs.set(k, await deviceCertificate(a.actorUserId, a.actorDeviceId))
    }
    const next = adminModule.replay(cached, actions, (u, d) => certs.get(`${u}:${d}`) ?? null, deps.adminPermissions)
    await store.put('adminState', guildId, next)
    return next
  }

  // MARK: - gateway events

  function reportError(e: unknown): void {
    emitError(ctx, e)
  }

  /**
   * Start-up check: the DS revoked this device while the app was closed, so no USER_KEYS_UPDATE
   * came. Without it, the stored device id goes to the gateway, which closes 4013, the app signs
   * out, and the next sign-in does the same. The device locks, as a locked store loads (no status
   * event: the start result reports 'revoked'), and the UI wipes it with signOutDevice and starts
   * again at needs_identity. Network failures and a slow DS skip the check: the next start checks.
   *
   * A half-linked device starts over the same way: the existing device certified it on the DS
   * (active), but the transfer never came, so this store has no certificate. Its link keys were in
   * memory only, and the DS starts no link for an active device, so it cannot finish.
   */
  async function lockIfUnusable(): Promise<void> {
    const r = row
    if (r === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const keys = await Promise.race([
      transport.getUserKeys(r.userId).catch(() => null),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), START_CHECK_MS))),
    ])
    clearTimeout(timer)
    const me = keys?.devices.find((d) => d.id === r.deviceId)
    const halfLinked = me?.status === 'active' && r.deviceCertificate.length === 0
    if ((me?.status === 'revoked' || halfLinked) && row === r) await markLocked(r)
  }

  async function bestEffort(p: Promise<unknown>): Promise<void> {
    try {
      await p
    } catch (e) {
      reportError(e)
    }
  }

  async function onGatewayEvent(event: CryptoGatewayEvent): Promise<void> {
    try {
      switch (event.t) {
        case 'USER_KEYS_UPDATE': {
          const d = event.d
          keyCache.delete(d.userId)
          if (self !== null && d.userId === self.userId) {
            if (d.kind === 'device_revoked' && d.deviceId === self.deviceId) {
              // GET /users/:id/keys needs no active device (GET /devices may refuse a revoked caller).
              const me = (await transport.getUserKeys(self.userId)).devices.find((x) => x.id === self!.deviceId)
              if (!me || me.status === 'revoked') {
                await onSelfRevoked(me ?? null)
                return
              }
            }
            if (await ktClient.active()) await bestEffort(ktSelfCheck())
          } else if ((await store.get('contacts', d.userId)) !== undefined) {
            await userKeys(d.userId, true)
          }
          return
        }
        case 'KT_TREE_HEAD':
          await ktClient.onTreeHead(event.d)
          if (self !== null) await bestEffort(ktSelfCheck())
          return
        case 'KEY_PACKAGES_LOW':
          if (self !== null && event.d.deviceId === self.deviceId) await replenishKeyPackages()
          return
        case 'DEVICE_LINK':
          await links.onEvent(event.d)
          return
        default:
          return
      }
    } catch (e) {
      reportError(e)
    }
  }

  const links = createLinkEngine({
    ctx,
    self: requireSelf,
    row: requireRow,
    pendingDevice,
    setLinking: () => {
      if (state !== 'linking') {
        state = 'linking'
        emitStatus()
      }
    },
    deviceName: () => requireInit().deviceName,
    async completeNewDevice(r, history) {
      // Keys first: 'ready' opens the app, which decrypts the open channel at once.
      const row = await pinDs(r)
      await importEpochSecrets(ctx, history, true)
      await becomeReady(row)
      await bestEffort(replenishKeyPackages())
    },
    exportHistory,
    reportError,
  })

  const service: IdentityService = {
    async load(opts) {
      init = opts
      const stored = await store.get('identity', SELF)
      if (!stored) {
        row = null
        self = null
        state = 'needs_identity'
        return null
      }
      if (stored.userId !== opts.userId) throw new CryptoError('StoreCorrupt', 'the store belongs to another user')
      row = stored
      if (stored.lockedAtMs != null) {
        self = null
        state = 'revoked'
        return null
      }
      if (stored.deviceCertificate.length === 0 || stored.master === null || stored.dsk === null) {
        self = null
        state = 'linking'
        await lockIfUnusable()
        return null
      }
      self = buildSelf(stored)
      state = 'ready'
      await lockIfUnusable()
      return self
    },
    self: requireSelf,
    status,

    setupFirstDevice: () => createIdentity('first'),
    resetIdentity: () => createIdentity('reset'),
    restoreFromRecoveryKey,
    rotateRecoveryKey,

    linkAsNewDevice: (mode) => links.linkAsNewDevice(mode),
    linkScan: (p) => links.linkScan(p),
    linkAccept: (id) => links.linkAccept(id),
    listLinkSessions: () => links.listLinkSessions(),
    linkConfirmSas: (id, m) => links.linkConfirmSas(id, m),
    linkCancel: (id) => links.linkCancel(id),

    listDevices,
    revokeDevice,
    async renameDevice(deviceId, name) {
      requireSelf()
      await transport.renameDevice(deviceId, name)
    },
    signOutDevice,
    proveDevice,

    async getTrust(userId) {
      if (self?.userId !== userId) await userKeys(userId)
      return trustInfo(userId)
    },
    async getSafetyNumber(userId) {
      const s = requireSelf()
      if (userId === s.userId) throw new CryptoError('Unsupported', 'no safety number with yourself')
      const c = await requireContact(userId)
      return identity.safetyNumber({ userId: s.userId, masterKey: s.chain.master.publicKey }, { userId, masterKey: (c.candidate ?? null)?.masterKey ?? c.masterKey })
    },
    async verifyQr(payload) {
      const s = requireSelf()
      const q = identity.parseVerifyQr(payload)
      if (q.peerUserId !== s.userId || q.userId === s.userId) return { userId: q.userId, match: false }
      const c = await requireContact(q.userId)
      // During a key change the QR code of the new master key verifies it (§12.5 re-verification).
      const expected = (c.candidate ?? null)?.masterKey ?? c.masterKey
      const match = equalBytes(q.peerMasterKey, s.chain.master.publicKey) && equalBytes(q.masterKey, expected)
      if (match) await adoptCandidate(c, 'verified')
      return { userId: q.userId, match }
    },
    async setVerified(userId, verified) {
      const c = await requireContact(userId)
      if (verified) await adoptCandidate(c, 'verified')
      // A pending key change stays pending: only an acknowledgement or a verification ends it.
      else if (c.trust !== 'changed') await store.put('contacts', userId, { ...c, trust: 'tofu', verifiedAtMs: null })
      return trustInfo(userId)
    },
    async acknowledgeKeyChange(userId) {
      const c = await store.get('contacts', userId)
      if (c?.trust === 'changed') await adoptCandidate(c, 'tofu')
      return trustInfo(userId)
    },

    chainContextFor,
    deviceCertificate,
    deviceOwnerCertificate,
    listContactDevices,
    trustOf,
    onGatewayEvent,
    handleInboxItem,
    onDskRotated(cb) {
      dskListeners.push(cb)
    },
    adminState,
    replenishKeyPackages,
    backupNow,
    ktSelfCheck,
    async treeHeadForGossip(groupId) {
      return ktClient.gossip(groupId)
    },
    async observeTreeHead(treeHead, fromUserId) {
      await ktClient.observeEncoded(treeHead, fromUserId)
    },
  }
  return service
}
