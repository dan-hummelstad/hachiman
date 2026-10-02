/** GET /api/v1/limits — upload limits the client checks before it uploads. */
import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { getLimits } from '@/lib/files'

export async function GET(): Promise<NextResponse> {
  try {
    await requireUser()
    return NextResponse.json(getLimits())
  } catch (err) {
    return errorResponse(err)
  }
}
