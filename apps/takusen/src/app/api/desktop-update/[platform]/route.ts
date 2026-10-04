/**
 * GET /api/desktop-update/:platform — public, no auth. `platform` is `macos` or `windows`.
 * Returns `{sha, sha256}` of the newest desktop build (contract §4 Desktop updates),
 * 404 when updates are not configured or there is no build.
 */
import { NextResponse } from 'next/server'

import { isDesktopPlatform, latestDesktopBuild } from '@/lib/desktop-update'

export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }): Promise<NextResponse> {
  const { platform } = await params
  if (!isDesktopPlatform(platform)) return NextResponse.json({ error: 'NotFound' }, { status: 404 })
  try {
    const build = await latestDesktopBuild(platform)
    if (!build) return NextResponse.json({ error: 'NotFound' }, { status: 404 })
    return NextResponse.json({ sha: build.sha, sha256: build.sha256 })
  } catch (err) {
    console.warn('[desktop-update]', err)
    return NextResponse.json({ error: 'UpstreamUnavailable' }, { status: 502 })
  }
}
