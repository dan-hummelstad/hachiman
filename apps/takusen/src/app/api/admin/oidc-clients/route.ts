/**
 * GET /api/admin/oidc-clients — AdminOidcClient[] (read-only; never the secret),
 * with the live grants per client. Admin only (contract §4 Admin API).
 */
import { asc } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db/client'
import { oidcClients } from '@/db/schema'
import type { AdminOidcClient } from '@/lib/admin'
import { oidcClientActivity } from '@/lib/admin-stats'
import { adminRoute } from '@/lib/api-helpers'

export const GET = adminRoute(async () => {
  const [rows, activity] = await Promise.all([
    db.select().from(oidcClients).orderBy(asc(oidcClients.clientId)),
    oidcClientActivity(),
  ])
  return NextResponse.json(
    rows.map(
      (c): AdminOidcClient => ({
        id: c.id,
        clientId: c.clientId,
        isPublic: c.isPublic,
        redirectUris: c.redirectUris,
        scopes: c.scopes,
        activeUsers: activity.get(c.clientId)?.activeUsers ?? 0,
        activeSessions: activity.get(c.clientId)?.activeSessions ?? 0,
        createdAt: c.createdAt.toISOString(),
      }),
    ),
  )
})
