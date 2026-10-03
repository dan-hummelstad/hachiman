/**
 * The `X-Hachiman-Device` check of the routes marked D in §12.12: the device
 * belongs to the user, is not revoked, signed the request with its MLS key
 * (device-proof.ts), and is the device of the caller's bearer token
 * (device-binding.ts). `pending` devices pass only with `allowPending` (the
 * device and link routes).
 */
import { ApiError } from '@/lib/errors'
import { redis } from '@/lib/events'

import { redisDeviceBindings, type DeviceBindings } from './device-binding'
import { checkDeviceProof, readRequestProof, redisNonceStore, type NonceStore, type RequestProof } from './device-proof'
import { drizzleMlsRepo } from './repo.drizzle'
import type { DeviceRow, MlsRepo } from './repo'

export const DEVICE_HEADER = 'x-hachiman-device'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** last_seen_at is written at most this often per device. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60_000

/** The credential that claims the device: the OIDC grant of the bearer token. */
export interface DeviceCredential {
  bindings: DeviceBindings
  /** Null for a dashboard cookie session (no grant to bind). */
  grantId: string | null
}

/** The signed request and the nonce store of the device proof (device-proof.ts). */
export interface ProofContext {
  proof: RequestProof
  nonces: NonceStore
}

export async function requireDevice(req: Request, userId: string, opts?: { allowPending?: boolean }): Promise<DeviceRow> {
  // Lazy: keeps next-auth out of the import graph of the unit tests.
  const { bearerGrantId } = await import('@/lib/auth-helpers')
  const credential: DeviceCredential = { bindings: redisDeviceBindings(redis()), grantId: await bearerGrantId(req) }
  const proof: ProofContext = { proof: await readRequestProof(req), nonces: redisNonceStore(redis()) }
  return requireDeviceWith(drizzleMlsRepo(), req.headers.get(DEVICE_HEADER), userId, opts, new Date(), credential, proof)
}

/**
 * POST /devices (§12.12): the request has no device id yet. It must carry a device proof by the
 * key that its body presents (device id "" in the signed message).
 */
export async function requireRegistrationProof(proof: RequestProof, mlsSignatureKey: Uint8Array): Promise<void> {
  await checkDeviceProof(proof, '', mlsSignatureKey, redisNonceStore(redis()), new Date())
}

/**
 * `proof` is required in production (requireDevice always passes it). Unit tests of other
 * checks leave it out.
 */
export async function requireDeviceWith(
  repo: MlsRepo,
  header: string | null,
  userId: string,
  opts: { allowPending?: boolean } = {},
  now: Date = new Date(),
  credential?: DeviceCredential,
  proof?: ProofContext,
): Promise<DeviceRow> {
  const id = header?.trim().toLowerCase() ?? ''
  if (!id) throw new ApiError('DeviceRequired', 400, 'X-Hachiman-Device is required')
  if (!UUID.test(id)) throw new ApiError('DeviceRequired', 400, 'X-Hachiman-Device is not a device id')
  const device = await repo.getDevice(id)
  if (!device || device.userId !== userId) throw new ApiError('DeviceNotActive', 403, 'unknown device')
  if (device.status === 'revoked') throw new ApiError('DeviceNotActive', 403, 'device revoked')
  if (device.status === 'pending' && !opts.allowPending) throw new ApiError('DeviceNotActive', 403, 'device not active')
  // Before the binding: a request without the device key must not bind or move a grant.
  if (proof) await checkDeviceProof(proof.proof, device.id, device.mlsSignatureKey, proof.nonces, now)
  if (credential?.grantId) await checkBinding(repo, credential.bindings, credential.grantId, device)
  if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
    await repo.updateDevice(device.id, { lastSeenAt: now })
  }
  return device
}

/**
 * The grant may claim its bound device only. A grant whose bound device is
 * not active may move to a pending device (a client that registers again).
 */
async function checkBinding(repo: MlsRepo, bindings: DeviceBindings, grantId: string, device: DeviceRow): Promise<void> {
  const bound = await bindings.bind(grantId, device.id)
  if (bound === device.id) return
  const previous = await repo.getDevice(bound)
  const previousActive = previous !== null && previous.userId === device.userId && previous.status === 'active'
  if (!previousActive && device.status === 'pending' && (await bindings.rebind(grantId, bound, device.id))) return
  throw new ApiError('DeviceNotActive', 403, 'the token belongs to another device')
}

/** `@me` (or the caller's own id) → the caller device. Other ids → that id. */
export function resolveDeviceParam(param: string, caller: DeviceRow): string {
  return param === '@me' || param === '%40me' ? caller.id : param
}
