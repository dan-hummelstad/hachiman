/**
 * POST /api/v1/uploads?filename=<name>&width=<n>&height=<n> — raw file body,
 * streamed to S3 (docs/gateway-protocol.md §4 Files). Returns the Attachment.
 *
 * Middleware skips this path (see src/middleware.ts), so CORS is applied here.
 */
import { randomUUID } from 'node:crypto'
import { pipeline, Readable, Transform } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { uploads } from '@/db/schema'
import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { applyCors, preflight } from '@/lib/cors'
import { UploadTooLargeError, ValidationError } from '@/lib/errors'
import {
  FILENAME_MAX_LENGTH,
  getLimits,
  normalizeContentType,
  parseContentLength,
  toAttachment,
  uploadKey,
} from '@/lib/files'
import { deleteObjects, putObject } from '@/lib/storage'

export const runtime = 'nodejs'

const dimension = z.coerce.number().int().positive().max(65535).optional()
const uploadQuerySchema = z.object({
  filename: z.string().trim().min(1).max(FILENAME_MAX_LENGTH),
  width: dimension,
  height: dimension,
})

/**
 * Passes exactly `length` bytes or fails the stream. S3 is told the length up
 * front, so a short body must fail here rather than leave the PUT waiting.
 */
function exactLength(length: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length
      if (seen > length) done(new UploadTooLargeError('Body is longer than Content-Length'))
      else done(null, chunk)
    },
    flush(done) {
      done(seen < length ? new ValidationError('Body is shorter than Content-Length') : null)
    },
  })
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const session = await requireUser()
  const params = req.nextUrl.searchParams
  const query = uploadQuerySchema.parse({
    filename: params.get('filename') ?? undefined,
    width: params.get('width') ?? undefined,
    height: params.get('height') ?? undefined,
  })
  const { maxUploadBytes } = getLimits()
  const length = parseContentLength(req.headers.get('content-length'), maxUploadBytes)
  if (length === null) {
    throw new UploadTooLargeError(`Content-Length is required and at most ${maxUploadBytes} bytes`)
  }
  const contentType = normalizeContentType(req.headers.get('content-type'))

  const id = randomUUID()
  const key = uploadKey(id, query.filename)
  const source = req.body ? Readable.fromWeb(req.body as NodeWebStream) : Readable.from([])
  // A dropped client or a wrong length must cancel the PUT: S3 was promised
  // `length` bytes and would otherwise wait for the rest.
  const abort = new AbortController()
  const body = pipeline(source, exactLength(length), (err) => {
    if (err) abort.abort(err)
  })
  try {
    await putObject(key, body, length, contentType, abort.signal)
  } catch (err) {
    throw abort.signal.aborted ? abort.signal.reason : err
  } finally {
    // An S3 failure leaves the request body unread; release it.
    source.destroy()
  }

  const [row] = await db
    .insert(uploads)
    .values({
      id,
      uploaderId: session.user.id,
      key,
      filename: query.filename,
      size: length,
      contentType,
      width: query.width ?? null,
      height: query.height ?? null,
    })
    .returning()
    .catch(async (err: unknown) => {
      // Only a row lets anything delete the object later.
      await deleteObjects([key])
      throw err
    })
  return NextResponse.json(toAttachment(row), { status: 201 })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let res: NextResponse
  try {
    res = await handle(req)
  } catch (err) {
    // A client that hung up mid-upload is not a server error, and nobody
    // reads this response.
    if (req.signal.aborted) return new NextResponse(null, { status: 499 })
    res = errorResponse(err)
  }
  applyCors(res, req.headers.get('origin'))
  return res
}

export function OPTIONS(req: NextRequest): NextResponse {
  return preflight(req.headers.get('origin'))
}
