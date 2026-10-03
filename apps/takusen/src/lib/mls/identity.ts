/**
 * Devices, master keys, device-signing keys and UserKeys (docs/gateway-protocol.md
 * §12.4, §12.12 "Devices and keys"). Each key change appends its KT entry in
 * the same transaction (§12.14).
 */
import { ApiError } from '@/lib/errors'

import { bytesEqual, toB64 } from './bytes'
import { MAX_DEVICES } from './config'
import type { DsDeps } from './context'
import { DeviceRevocationReason, KtEntryType, type DeviceCertificate, type MasterKeyRecord, type WireUserKeys } from './crypto'
import { emitUserKeysUpdate, type Outbox } from './events'
import { appendKtEntry, ktIndexOfObjects } from './kt'
import { revokeDevicesWith } from './membership'
import { checkKeyPackagesLow } from './reconcile'
import type { DeviceRow, DskRow, MasterKeyRow, MlsRepo, RevokeReason } from './repo'
import { toWireDevice } from './shapes'
import { parseLinkOffer } from './wire-format'

type Deps = Pick<DsDeps, 'ds' | 'config' | 'now'>

export function currentMaster(rows: MasterKeyRow[]): MasterKeyRow | null {
  return rows.find((m) => m.supersededAt === null) ?? null
}

export function currentDsk(rows: DskRow[]): DskRow | null {
  return rows.find((m) => m.supersededAt === null) ?? null
}

// MARK: - Devices

/**
 * `mlsSignatureKey`: the key of the device proof (§12.12). The route requires it. The certificate
 * must certify the same key later (checkCertificateFields).
 */
export async function registerDevice(
  repo: MlsRepo,
  userId: string,
  body: { name: string; platform: DeviceRow['platform']; clientVersion: string; mlsSignatureKey?: Uint8Array | null },
) {
  return repo.transaction(async (r) => {
    if ((await r.countLiveDevices(userId)) >= MAX_DEVICES) throw new ApiError('TooManyDevices', 409, `at most ${MAX_DEVICES} devices`)
    const { mlsSignatureKey = null, ...rest } = body
    const d = await r.insertDevice({ userId, ...rest, mlsSignatureKey })
    return toWireDevice(d, null)
  })
}

export async function listOwnDevices(repo: MlsRepo, userId: string) {
  const [devices, revocations] = await Promise.all([repo.listDevices(userId), repo.listRevocations(userId)])
  const byDevice = new Map(revocations.map((r) => [r.deviceId, r]))
  return devices.map((d) => toWireDevice(d, byDevice.get(d.id) ?? null))
}

async function ownDevice(repo: MlsRepo, userId: string, deviceId: string): Promise<DeviceRow> {
  const d = await repo.getDevice(deviceId)
  if (!d || d.userId !== userId) throw new ApiError('UnknownDevice', 404, 'unknown device')
  return d
}

/** PATCH /devices/:id: the REST name only. It does not certify the device again (§12.5). */
export async function renameDevice(repo: MlsRepo, userId: string, deviceId: string, name: string) {
  const d = await ownDevice(repo, userId, deviceId)
  if (d.status === 'revoked') throw new ApiError('DeviceNotActive', 403, 'device revoked')
  const row = await repo.updateDevice(d.id, { name })
  return toWireDevice(row, null)
}

/**
 * PUT /devices/:id/certificate (§12.12). The caller is the device itself or
 * another active device of the user. The certificate must verify under the
 * current DSK and master key. A device with keys keeps them, and a device in a
 * link session gets the keys of the offer.
 */
export async function putCertificate(
  repo: MlsRepo,
  deps: Deps,
  out: Outbox,
  caller: { userId: string; device: DeviceRow },
  targetId: string,
  certificate: Uint8Array,
) {
  return repo.transaction(async (r) => {
    const target = await ownDevice(r, caller.userId, targetId)
    if (target.status === 'revoked') throw new ApiError('DeviceNotActive', 403, 'device revoked')
    if (target.id !== caller.device.id && caller.device.status !== 'active') {
      throw new ApiError('DeviceNotActive', 403, 'only an active device can certify another device')
    }
    const master = currentMaster(await r.listMasterKeys(caller.userId))
    const dsks = await r.listDsks(caller.userId)
    const dsk = currentDsk(dsks)
    if (!master || !dsk) throw new ApiError('InvalidCertificate', 400, 'the user has no current master key and DSK')
    const cert = deps.ds.verifyDeviceCertificate(certificate, dsk.cert, master.record)
    if (!cert) {
      const stale = dsks.some((old) => old.supersededAt !== null && deps.ds.verifyDeviceCertificate(certificate, old.cert, master.record))
      if (stale) throw new ApiError('StaleDeviceSigningKey', 409, 'the certificate uses a superseded DSK')
      throw new ApiError('InvalidCertificate', 400, 'the certificate does not verify under the current DSK')
    }
    checkCertificateFields(cert, caller.userId, target, dsk.generation)
    const link = await r.openLinkSessionOfDevice(target.id, deps.now())
    if (link) {
      const offer = parseLinkOffer(link.offer)
      if (!bytesEqual(offer.mlsSignatureKey, cert.mlsSignatureKey) || !bytesEqual(offer.hpkeKey, cert.hpkeKey)) {
        throw new ApiError('InvalidCertificate', 400, 'the certificate keys differ from the link offer')
      }
    }
    const row = await r.updateDevice(target.id, {
      status: 'active',
      certificate,
      mlsSignatureKey: cert.mlsSignatureKey,
      hpkeKey: cert.hpkeKey,
      dskGeneration: cert.dskGeneration,
    })
    await appendKtEntry(r, deps.ds, { type: KtEntryType.DEVICE_CERTIFICATE, userId: caller.userId, object: certificate, now: deps.now() })
    await emitUserKeysUpdate(r, out, { userId: caller.userId, kind: 'device_added', deviceId: target.id })
    return toWireDevice(row, null)
  })
}

function checkCertificateFields(cert: DeviceCertificate, userId: string, target: DeviceRow, dskGeneration: number): void {
  if (cert.userId !== userId || cert.deviceId !== target.id) throw new ApiError('InvalidCertificate', 400, 'the certificate is for another device')
  if (cert.dskGeneration !== dskGeneration) throw new ApiError('StaleDeviceSigningKey', 409, 'the certificate uses a superseded DSK')
  if (cert.mlsSignatureKey.length !== 32 || cert.hpkeKey.length !== 32) throw new ApiError('InvalidCertificate', 400, 'bad key lengths')
  if (target.mlsSignatureKey && !bytesEqual(target.mlsSignatureKey, cert.mlsSignatureKey)) {
    throw new ApiError('InvalidCertificate', 400, 'the device keys cannot change')
  }
  if (target.hpkeKey && !bytesEqual(target.hpkeKey, cert.hpkeKey)) throw new ApiError('InvalidCertificate', 400, 'the device keys cannot change')
}

const REASON_ID: Record<Exclude<RevokeReason, 'password_reset'>, number> = {
  user: DeviceRevocationReason.USER,
  lost: DeviceRevocationReason.LOST,
  compromised: DeviceRevocationReason.COMPROMISED,
  signed_out: DeviceRevocationReason.SIGNED_OUT,
}

/**
 * POST /devices/:id/revoke (§12.12). `revocation` is required, except for a
 * pending device that signs itself out. Reasons user, lost and compromised
 * verify under the current master key. signed_out is the caller's own device
 * and verifies under the MLS key of its certificate.
 */
export async function revokeDevice(
  repo: MlsRepo,
  deps: Deps,
  out: Outbox,
  caller: { userId: string; device: DeviceRow },
  targetId: string,
  body: { revocation: Uint8Array | null; reason: RevokeReason },
): Promise<void> {
  await repo.transaction(async (r) => {
    const target = await ownDevice(r, caller.userId, targetId)
    if (target.status === 'revoked') return
    if (body.reason === 'password_reset') throw new ApiError('InvalidRevocation', 400, 'password_reset is a server revocation')
    if (body.revocation === null) {
      if (target.status !== 'pending' || target.id !== caller.device.id || body.reason !== 'signed_out') {
        throw new ApiError('InvalidRevocation', 400, 'a revocation is required')
      }
    } else {
      if (body.reason === 'signed_out' && target.id !== caller.device.id) {
        throw new ApiError('InvalidRevocation', 400, 'signed_out is only for the caller device')
      }
      if (body.reason !== 'signed_out' && caller.device.status !== 'active') {
        throw new ApiError('DeviceNotActive', 403, 'the caller device is not active')
      }
      const master = currentMaster(await r.listMasterKeys(caller.userId))
      if (!master) throw new ApiError('InvalidRevocation', 400, 'the user has no current master key')
      const rev = deps.ds.verifyRevocation(body.revocation, {
        master: master.record,
        deviceCertificate: body.reason === 'signed_out' ? target.certificate : null,
      })
      if (!rev || rev.userId !== caller.userId || rev.deviceId !== target.id || rev.reason !== REASON_ID[body.reason]) {
        throw new ApiError('InvalidRevocation', 400, 'the revocation does not verify')
      }
    }
    const now = deps.now()
    await revokeDevicesWith(r, out, { userId: caller.userId, devices: [{ id: target.id, revocation: body.revocation }], reason: body.reason, now })
    if (body.revocation) await appendKtEntry(r, deps.ds, { type: KtEntryType.DEVICE_REVOCATION, userId: caller.userId, object: body.revocation, now })
  })
}

// MARK: - Master key and device-signing key

/** Signature check of a rotation record: prev_signature under the previous master record (§12.4). */
function verifiesRotation(deps: Deps, record: Uint8Array, previous: MasterKeyRow): MasterKeyRecord | null {
  return deps.ds.verifyMasterKeyRecord(record, previous.record)
}

/**
 * PUT /users/@me/master-key (§12.12), three cases:
 *  1. no master key row: the first device;
 *  2. no current master key (after a password reset): the newest superseded
 *     record byte-equal (restore), or generation + 1 with prev_signature null;
 *  3. prev_signature verifies under the current master key (rotation).
 * Else 409 MasterKeyExists. The DSK cert must verify under the record.
 */
export async function putMasterKey(repo: MlsRepo, deps: Deps, out: Outbox, userId: string, body: { record: Uint8Array; dskCert: Uint8Array }): Promise<void> {
  await repo.transaction(async (r) => {
    const rec = deps.ds.verifyMasterKeyRecord(body.record, null)
    if (!rec || rec.userId !== userId) throw new ApiError('InvalidCertificate', 400, 'the master key record does not verify')
    const rows = await r.listMasterKeys(userId)
    const current = currentMaster(rows)
    const newest = rows[0] ?? null
    const now = deps.now()

    let restored = false
    if (!newest) {
      if (rec.generation !== 1 || rec.prevSignature !== null) throw new ApiError('InvalidCertificate', 400, 'the first master key has generation 1')
    } else if (!current) {
      if (bytesEqual(newest.record, body.record)) restored = true
      else if (rec.generation !== newest.generation + 1 || rec.prevSignature !== null) {
        throw new ApiError('MasterKeyExists', 409, 'restore the newest master key or make generation + 1 without prev_signature')
      }
    } else {
      if (rec.generation !== current.generation + 1 || rec.prevSignature === null || !verifiesRotation(deps, body.record, current)) {
        throw new ApiError('MasterKeyExists', 409, 'a master key exists and the record has no valid prev_signature')
      }
    }

    const dsk = deps.ds.verifyDskCert(body.dskCert, body.record)
    if (!dsk || dsk.userId !== userId || dsk.masterGeneration !== rec.generation) {
      throw new ApiError('InvalidCertificate', 400, 'the DSK cert does not verify under the record')
    }
    const dsks = await r.listDsks(userId)
    const curDsk = currentDsk(dsks)
    const dskIsNew = !curDsk || !bytesEqual(curDsk.cert, body.dskCert)
    if (dskIsNew && dsk.generation !== (dsks[0]?.generation ?? 0) + 1) {
      throw new ApiError('InvalidCertificate', 400, 'the DSK generation must be the next one')
    }

    if (restored) await r.restoreMasterKey(userId, rec.generation)
    else {
      await r.supersedeMasterKey(userId, now)
      await r.insertMasterKey({ userId, generation: rec.generation, publicKey: rec.publicKey, record: body.record })
      await appendKtEntry(r, deps.ds, { type: KtEntryType.MASTER_KEY, userId, object: body.record, now })
    }
    if (dskIsNew) {
      await r.supersedeDsk(userId, now)
      await r.insertDsk({ userId, generation: dsk.generation, masterGeneration: dsk.masterGeneration, publicKey: dsk.publicKey, cert: body.dskCert })
      await appendKtEntry(r, deps.ds, { type: KtEntryType.DEVICE_SIGNING_KEY, userId, object: body.dskCert, now })
      await deleteStaleKeyPackages(r, deps, out, userId, dsk.generation)
    }
    await emitUserKeysUpdate(r, out, { userId, kind: 'master_key_changed', deviceId: null })
  })
}

/**
 * PUT /users/@me/device-signing-key (§12.12): the cert verifies under the
 * current master key and has generation + 1. Stale key packages go (§12.7.2).
 */
export async function putDeviceSigningKey(repo: MlsRepo, deps: Deps, out: Outbox, userId: string, cert: Uint8Array): Promise<void> {
  await repo.transaction(async (r) => {
    const master = currentMaster(await r.listMasterKeys(userId))
    if (!master) throw new ApiError('InvalidCertificate', 400, 'the user has no current master key')
    const dsk = deps.ds.verifyDskCert(cert, master.record)
    const dsks = await r.listDsks(userId)
    const next = (dsks[0]?.generation ?? 0) + 1
    if (!dsk || dsk.userId !== userId || dsk.masterGeneration !== master.generation) {
      throw new ApiError('InvalidCertificate', 400, 'the DSK cert does not verify under the current master key')
    }
    if (dsk.generation !== next) throw new ApiError('StaleDeviceSigningKey', 409, `the DSK generation must be ${next}`)
    const now = deps.now()
    await r.supersedeDsk(userId, now)
    await r.insertDsk({ userId, generation: dsk.generation, masterGeneration: dsk.masterGeneration, publicKey: dsk.publicKey, cert })
    await appendKtEntry(r, deps.ds, { type: KtEntryType.DEVICE_SIGNING_KEY, userId, object: cert, now })
    await deleteStaleKeyPackages(r, deps, out, userId, dsk.generation)
    await emitUserKeysUpdate(r, out, { userId, kind: 'dsk_rotated', deviceId: null })
  })
}

/**
 * §12.7.2 "DSK rotation": deletes every key package of the user whose chain
 * has a lower dsk_generation, and tells each device (KEY_PACKAGES_LOW,
 * remaining 0) for each enabled suite.
 */
async function deleteStaleKeyPackages(r: MlsRepo, deps: Deps, out: Outbox, userId: string, generation: number): Promise<void> {
  const stale: string[] = []
  for (const kp of await r.listKeyPackagesOfUser(userId)) {
    let keep = false
    try {
      const insp = await deps.ds.inspectKeyPackage(kp.data)
      keep = (insp.chain?.device.dskGeneration ?? -1) >= generation
    } catch {
      keep = false
    }
    if (!keep) stale.push(kp.id)
  }
  await r.deleteKeyPackages(stale)
  for (const d of await r.listDevices(userId)) {
    if (d.status === 'revoked') continue
    for (const suite of deps.config.suites) {
      await checkKeyPackagesLow(r, out, d.id, suite)
    }
  }
}

// MARK: - UserKeys

/** GET /users/:id/keys (§12.12): the caller shares a guild or DM with the user, or is the user. */
export async function userKeys(repo: MlsRepo, deps: Pick<DsDeps, 'ds'>, callerId: string, userId: string): Promise<WireUserKeys> {
  if (callerId !== userId && !(await repo.sharesGuildOrDm(callerId, userId))) throw new ApiError('NotFound', 404, 'unknown user')
  const [masters, dsks, devices, revocations, kt] = await Promise.all([
    repo.listMasterKeys(userId),
    repo.listDsks(userId),
    repo.listDevices(userId),
    repo.listRevocations(userId),
    ktIndexOfObjects(repo, deps.ds, userId),
  ])
  const ktOf = (type: number, object: Uint8Array | null) => {
    const hit = object ? kt.get(`${type}:${toB64(object)}`) : undefined
    return { ktIndex: hit?.idx ?? null, ktEntry: hit ? toB64(hit.entry) : null }
  }
  const master = currentMaster(masters)
  const dsk = currentDsk(dsks)
  const revByDevice = new Map(revocations.map((x) => [x.deviceId, x]))
  return {
    userId,
    masterKey: master ? { generation: master.generation, record: toB64(master.record), ...ktOf(KtEntryType.MASTER_KEY, master.record) } : null,
    deviceSigningKey: dsk ? { generation: dsk.generation, cert: toB64(dsk.cert), ...ktOf(KtEntryType.DEVICE_SIGNING_KEY, dsk.cert) } : null,
    devices: devices
      .filter((d) => d.certificate !== null || d.status === 'revoked')
      .map((d) => {
        const rev = revByDevice.get(d.id)?.revocation ?? null
        const revKt = ktOf(KtEntryType.DEVICE_REVOCATION, rev)
        return {
          id: d.id,
          status: d.status,
          certificate: d.certificate ? toB64(d.certificate) : null,
          revocation: rev ? toB64(rev) : null,
          ...ktOf(KtEntryType.DEVICE_CERTIFICATE, d.certificate),
          revocationKtIndex: revKt.ktIndex,
          revocationKtEntry: revKt.ktEntry,
        }
      }),
  }
}
