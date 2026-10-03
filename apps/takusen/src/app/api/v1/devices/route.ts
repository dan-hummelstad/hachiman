/**
 * POST /api/v1/devices {name, platform, clientVersion, mlsSignatureKey} — a new device, status
 * pending (§12.12). The request carries a device proof by `mlsSignatureKey` (device id "").
 * GET  /api/v1/devices — the caller's devices, revoked included.
 */
import { z } from 'zod'

import { ApiError } from '@/lib/errors'
import { b64 } from '@/lib/mls/bytes'
import { requireRegistrationProof } from '@/lib/mls/device-auth'
import { readRequestProof } from '@/lib/mls/device-proof'
import { listOwnDevices, registerDevice } from '@/lib/mls/identity'
import { body, dsRoute, json } from '@/lib/mls/route'

const registerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['electron', 'browser']),
  clientVersion: z.string().trim().min(1).max(32),
  mlsSignatureKey: b64(32),
})

export const POST = dsRoute('none', async ({ req, userId, repo }) => {
  const b = await body(req, registerSchema)
  if (b.mlsSignatureKey.length !== 32) throw new ApiError('ValidationError', 400, 'mlsSignatureKey must be 32 bytes')
  await requireRegistrationProof(await readRequestProof(req), b.mlsSignatureKey)
  return json(await registerDevice(repo, userId, b), 201)
})

export const GET = dsRoute('none', async ({ userId, repo }) => json(await listOwnDevices(repo, userId)))
