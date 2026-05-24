/**
 * GET    /api/servers/[id]/oidc — read this server's OIDC client config.
 * PATCH  /api/servers/[id]/oidc — update redirect URIs.
 * POST   /api/servers/[id]/oidc — regenerate the client secret (returns it once).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import {
  getOidcClientForServer,
  redirectUrisSchema,
  regenerateClientSecret,
  updateRedirectUris,
} from '@/lib/oidc-client-admin'
import { assertOwner } from '@/lib/servers'

interface RouteContext {
  params: Promise<{ id: string }>
}

const patchSchema = z.object({
  redirectUris: redirectUrisSchema,
})

function safeClient(client: { clientId: string; redirectUris: string[]; scopes: string[]; createdAt: Date }) {
  return {
    clientId: client.clientId,
    redirectUris: client.redirectUris,
    scopes: client.scopes,
    createdAt: client.createdAt,
  }
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await assertOwner(id, session.user.id)
    const client = await getOidcClientForServer(id)
    if (!client) {
      return NextResponse.json({ error: 'NotFound' }, { status: 404 })
    }
    return NextResponse.json({ client: safeClient(client) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await assertOwner(id, session.user.id)
    const body = await req.json()
    const parsed = patchSchema.parse(body)
    const client = await updateRedirectUris(id, parsed.redirectUris)
    return NextResponse.json({ client: safeClient(client) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await assertOwner(id, session.user.id)
    const { client, secret } = await regenerateClientSecret(id)
    return NextResponse.json({ client: safeClient(client), secret })
  } catch (err) {
    return errorResponse(err)
  }
}
