/**
 * GET /api/v1/files/:uploadId/:filename — public. Streams the object from S3,
 * with single-range support for media seeking (docs/gateway-protocol.md §4 Files).
 */
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'

import { db } from '@/db/client'
import { uploads } from '@/db/schema'
import { errorResponse } from '@/lib/api-helpers'
import { NotFoundError } from '@/lib/errors'
import { contentDisposition, parseRange } from '@/lib/files'
import { assertId } from '@/lib/guild-access'
import { getObjectStream } from '@/lib/storage'

export const runtime = 'nodejs'

interface RouteContext {
  params: Promise<{ uploadId: string; filename: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  try {
    const { uploadId, filename } = await ctx.params
    assertId(uploadId, 'file')
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1)
    // Only the canonical URL (the key) resolves.
    if (!row || row.key !== `${uploadId}/${filename}`) throw new NotFoundError('Unknown file')

    const headers = new Headers({
      'Content-Type': row.contentType,
      'Content-Disposition': contentDisposition(row.contentType, row.filename),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
    })
    const range = parseRange(req.headers.get('range'), row.size)
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${row.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range === null) {
      headers.set('Content-Length', String(row.size))
      return new Response(await getObjectStream(row.key), { status: 200, headers })
    }
    const { start, end } = range
    headers.set('Content-Range', `bytes ${start}-${end}/${row.size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(await getObjectStream(row.key, `bytes=${start}-${end}`), {
      status: 206,
      headers,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
