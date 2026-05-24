import { NextResponse } from 'next/server'
import {
  InviteExhaustedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  redeemInviteToUri,
} from '@/lib/invite-signing'

interface RouteParams {
  params: Promise<{ code: string }>
}

export async function POST(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  const { code } = await params
  try {
    const { joinUri } = await redeemInviteToUri(code)
    return NextResponse.json({ joinUri }, { status: 200 })
  } catch (err) {
    if (err instanceof InviteNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof InviteRevokedError) return NextResponse.json({ error: err.message }, { status: 410 })
    if (err instanceof InviteExpiredError) return NextResponse.json({ error: err.message }, { status: 410 })
    if (err instanceof InviteExhaustedError) return NextResponse.json({ error: err.message }, { status: 410 })
    console.error('[invite redeem] unexpected', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
