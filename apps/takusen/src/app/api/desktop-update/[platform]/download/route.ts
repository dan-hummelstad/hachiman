/**
 * GET /api/desktop-update/:platform/download — public, no auth. 302 to a short-lived signed
 * URL of the newest build's artifact zip (contract §4 Desktop updates), 404 when there is none.
 */
import { NextResponse } from 'next/server'

import { desktopBuildZipUrl, isDesktopPlatform } from '@/lib/desktop-update'

export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }): Promise<NextResponse> {
  const { platform } = await params
  if (!isDesktopPlatform(platform)) return NextResponse.json({ error: 'NotFound' }, { status: 404 })
  try {
    const url = await desktopBuildZipUrl(platform)
    if (!url) return NextResponse.json({ error: 'NotFound' }, { status: 404 })
    return NextResponse.redirect(url, 302)
  } catch (err) {
    console.warn('[desktop-update]', err)
    return NextResponse.json({ error: 'UpstreamUnavailable' }, { status: 502 })
  }
}
