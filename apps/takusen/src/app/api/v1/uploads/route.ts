/**
 * POST /api/v1/uploads?kind=blob — an encrypted attachment or thumbnail blob
 *      (§12.9). Stored as application/octet-stream with no file name.
 * POST /api/v1/uploads?filename=<name> — a plaintext profile image (avatar,
 *      icon, banner). Content-Type is its MIME type.
 * The raw body is streamed to S3 (docs/gateway-protocol.md §4 Files). Both
 * return `{ id, key, size }` (201).
 *
 * Middleware skips this path (see src/middleware.ts), so CORS is applied here.
 */
import { randomUUID } from 'node:crypto'
import { pipeline, Readable, Transform } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'

import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { uploads } from '@/db/schema'
import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { applyCors, preflight } from '@/lib/cors'
import { UploadTooLargeError, ValidationError } from '@/lib/errors'
import { getLimits, parseContentLength, parseUploadKind, toAttachment, uploadColumns } from '@/lib/files'
import { deleteObjects, putObject } from '@/lib/storage'

export const runtime = 'nodejs'

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
  const kind = parseUploadKind(req.nextUrl.searchParams)
  if (!kind) throw new ValidationError('Give either kind=blob or filename=<1 to 255 characters>')
  const { maxUploadBytes } = getLimits()
  const length = parseContentLength(req.headers.get('content-length'), maxUploadBytes)
  if (length === null) {
    throw new UploadTooLargeError(`Content-Length is required and at most ${maxUploadBytes} bytes`)
  }
  const id = randomUUID()
  // A blob ignores the request Content-Type: the MIME type is only in the envelope.
  const columns = uploadColumns(id, kind, req.headers.get('content-type'))
  const { key, contentType } = columns
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
    .values({ id, uploaderId: session.user.id, size: length, ...columns })
    .returning()
    .catch(async (err: unknown) => {
      // Only a row lets anything delete the object later.
      await deleteObjects([key])
      throw err
    })
  return NextResponse.json(toAttachment(row!), { status: 201 })
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
