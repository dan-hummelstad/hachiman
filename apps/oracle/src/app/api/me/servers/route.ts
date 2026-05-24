/**
 * GET  /api/me/servers — list the signed-in user's joined servers,
 *                       ordered by lastUsedAt desc nulls last, then addedAt desc.
 * POST /api/me/servers — add (or upsert by host/port) a server to the user's list.
 *                       409 if (userId, host, port) already exists; we still
 *                       return the existing row's payload so the client can
 *                       reconcile local state.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import {
  createUserServer,
  createUserServerSchema,
  listUserServers,
  serializeUserServer,
} from '@/lib/user-servers'

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const rows = await listUserServers(session.user.id)
    return NextResponse.json({ servers: rows.map(serializeUserServer) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const body = await req.json()
    const parsed = createUserServerSchema.parse(body)
    const { server, created } = await createUserServer(session.user.id, parsed)
    return NextResponse.json(serializeUserServer(server), {
      status: created ? 201 : 409,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
