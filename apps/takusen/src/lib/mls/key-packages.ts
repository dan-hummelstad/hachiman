/**
 * Key package upload and count (docs/gateway-protocol.md §12.7.2). Claims are
 * Takusen-internal (reconcile.ts, joins.ts): clients never claim key packages
 * of other devices.
 */
import { ApiError } from '@/lib/errors'

import { bytesEqual } from './bytes'
import { KEY_PACKAGE_MAX } from './config'
import type { DsDeps } from './context'
import { KEY_PACKAGE_LIFETIME_MS, type KeyPackageInspection } from './crypto'
import type { DeviceRow, MlsRepo, NewKeyPackage } from './repo'
import { currentDsk } from './identity'

/** Clock skew that the lifetime check allows. */
const LIFETIME_SLACK_MS = 24 * 60 * 60_000

/**
 * The §12.7.2 upload checks of one key package for `device`: it decodes, the
 * suite is the requested enabled suite, the identity is the caller, the leaf
 * key is the certified MLS key, the signature is valid, the chain is of the
 * current DSK, and the lifetime is at most 90 days. Throws 400 InvalidKeyPackage.
 */
export async function inspectOwnKeyPackage(
  deps: Pick<DsDeps, 'ds' | 'config' | 'now'>,
  device: DeviceRow,
  bytes: Uint8Array,
  cipherSuite: number,
  dskGeneration: number,
): Promise<KeyPackageInspection> {
  let insp: KeyPackageInspection
  try {
    insp = await deps.ds.inspectKeyPackage(bytes)
  } catch {
    throw new ApiError('InvalidKeyPackage', 400, 'the key package does not decode')
  }
  const now = deps.now().getTime()
  const fail = (why: string) => {
    throw new ApiError('InvalidKeyPackage', 400, why)
  }
  if (!deps.config.suites.includes(insp.cipherSuite)) fail('the suite is not enabled')
  if (insp.cipherSuite !== cipherSuite) fail('the key package has another suite')
  if (insp.userId !== device.userId || insp.deviceId !== device.id) fail('the identity is not the caller device')
  if (!device.mlsSignatureKey || !bytesEqual(insp.signatureKey, device.mlsSignatureKey)) fail('the leaf key is not the certified MLS key')
  if (!insp.signatureValid) fail('the signature is not valid')
  if (!insp.chain || insp.chain.device.deviceId !== device.id || !bytesEqual(insp.chain.device.mlsSignatureKey, device.mlsSignatureKey!)) {
    fail('the leaf has no chain for this device')
  }
  if (insp.chain!.device.dskGeneration !== dskGeneration) fail('the chain is not of the current device-signing key')
  if (insp.notAfterMs <= now || insp.notAfterMs > now + KEY_PACKAGE_LIFETIME_MS + LIFETIME_SLACK_MS) fail('the lifetime is above 90 days or over')
  return insp
}

export async function uploadKeyPackages(
  repo: MlsRepo,
  deps: Pick<DsDeps, 'ds' | 'config' | 'now'>,
  device: DeviceRow,
  body: { cipherSuite: number; keyPackages: Uint8Array[]; lastResort: Uint8Array | null },
): Promise<{ stored: number; total: number }> {
  const dsk = currentDsk(await repo.listDsks(device.userId))
  if (!dsk) throw new ApiError('InvalidKeyPackage', 400, 'the user has no device-signing key')
  const rows: NewKeyPackage[] = []
  const check = async (bytes: Uint8Array, lastResort: boolean): Promise<NewKeyPackage> => {
    const insp = await inspectOwnKeyPackage(deps, device, bytes, body.cipherSuite, dsk.generation)
    return { deviceId: device.id, userId: device.userId, cipherSuite: body.cipherSuite, ref: insp.ref, data: bytes, lastResort, expiresAt: new Date(insp.notAfterMs) }
  }
  for (const kp of body.keyPackages) rows.push(await check(kp, false))
  const lastResort = body.lastResort ? await check(body.lastResort, true) : null

  return repo.transaction(async (r) => {
    const have = (await r.countKeyPackages(device.id)).find((c) => c.cipherSuite === body.cipherSuite)?.count ?? 0
    const room = Math.max(0, KEY_PACKAGE_MAX - have)
    const stored = await r.insertKeyPackages(rows.slice(0, room))
    if (lastResort) await r.putLastResortKeyPackage(lastResort)
    return { stored, total: have + stored }
  })
}

export async function countKeyPackages(repo: MlsRepo, device: DeviceRow) {
  return repo.countKeyPackages(device.id)
}
