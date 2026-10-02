/**
 * POST /api/admin/sessions/revoke-all — `{ oidcRowsDeleted }`. Signs every
 * user out, the caller too; same as `pnpm -F @hachiman/takusen sessions:revoke`.
 * Admin only (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'

import { adminRoute } from '@/lib/api-helpers'
import { revokeAllSessions } from '@/lib/session-revocation'

export const POST = adminRoute(async () =>
  NextResponse.json({ oidcRowsDeleted: await revokeAllSessions() }),
)
