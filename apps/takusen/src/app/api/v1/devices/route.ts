/**
 * POST /api/v1/devices {name, platform, clientVersion} — a new device, status pending (§12.12).
 * GET  /api/v1/devices — the caller's devices, revoked included.
 */
import { z } from 'zod'

import { listOwnDevices, registerDevice } from '@/lib/mls/identity'
import { body, dsRoute, json } from '@/lib/mls/route'

const registerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['electron', 'browser']),
  clientVersion: z.string().trim().min(1).max(32),
})

export const POST = dsRoute('none', async ({ req, userId, repo }) => {
  const b = await body(req, registerSchema)
  return json(await registerDevice(repo, userId, b), 201)
})

export const GET = dsRoute('none', async ({ userId, repo }) => json(await listOwnDevices(repo, userId)))
