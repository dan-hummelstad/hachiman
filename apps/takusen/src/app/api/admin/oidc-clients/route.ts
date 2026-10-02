/**
 * GET /api/admin/oidc-clients — AdminOidcClient[] (read-only; never the secret).
 * Admin only (contract §4 Admin API).
 */
import { asc } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db/client'
import { oidcClients } from '@/db/schema'
import type { AdminOidcClient } from '@/lib/admin'
import { adminRoute } from '@/lib/api-helpers'

export const GET = adminRoute(async () => {
  const rows = await db.select().from(oidcClients).orderBy(asc(oidcClients.clientId))
  return NextResponse.json(
    rows.map(
      (c): AdminOidcClient => ({
        id: c.id,
        clientId: c.clientId,
        isPublic: c.isPublic,
        redirectUris: c.redirectUris,
        scopes: c.scopes,
        createdAt: c.createdAt.toISOString(),
      }),
    ),
  )
})
