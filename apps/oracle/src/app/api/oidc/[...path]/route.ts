/**
 * Bridge between Next.js's App Router (Web Fetch `Request` / `Response`)
 * and the Node-style `(IncomingMessage, ServerResponse) => void` callback
 * that `oidc-provider` (Koa under the hood) exposes via `provider.callback()`.
 *
 * Strategy (hand-written, mirrors the recipe in panva/node-oidc-provider's
 * docs/recipes/multi-tenant.md):
 *
 *   1. Buffer the incoming `Request` body into a Buffer.
 *   2. Build a Node-shaped IncomingMessage from method, URL, headers, body.
 *      We use a minimal Readable wrapped to look like http.IncomingMessage —
 *      Koa's body parsers only read `req.headers`, `req.url`, `req.method`,
 *      and consume the stream.
 *   3. Build a writable ServerResponse-shim using PassThrough that captures
 *      `writeHead`, `setHeader`, `getHeaders`, `write`, `end`. After the
 *      handler resolves, we turn the captured status + headers + body into
 *      a `Response`.
 *
 * We considered:
 *   - `@fastify/oidc-provider`: requires a Fastify host. Overkill.
 *   - `next-connect`: still gives you Node objects but adds a dep we don't
 *     need.
 *   - Mounting Koa as a sub-app via a custom Next server: throws away most
 *     of Next.js's request lifecycle and is not compatible with the App
 *     Router. Rejected.
 *
 * Hand-written wins on dependency footprint and is well-trodden for
 * oidc-provider in serverless / edge-ish hosts.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'

import { getOidcProvider } from '@/lib/oidc-provider'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function buildIncomingMessage(req: Request): Promise<IncomingMessage> {
  const url = new URL(req.url)
  // panva's `routes` (see oidc-provider.ts) include the `/api/oidc/` prefix
  // so discovery advertises working URLs and we can forward req.url verbatim
  // for those — EXCEPT `/.well-known/*`, which panva mounts at the router
  // root (not configurable). Strip the prefix there so panva's hardcoded
  // discovery route can match.
  const pathname = url.pathname.startsWith('/api/oidc/.well-known/')
    ? url.pathname.replace('/api/oidc', '')
    : url.pathname
  const search = url.search

  const bodyBuffer =
    req.method === 'GET' || req.method === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.from(await req.arrayBuffer())

  const socket = new Socket()
  const message = new IncomingMessage(socket)
  message.method = req.method
  message.url = `${pathname}${search}`
  message.headers = Object.fromEntries(req.headers.entries())
  // Koa reads body via the stream protocol, not from `message.body`.
  const stream = Readable.from(bodyBuffer)
  stream.on('data', (chunk) => message.emit('data', chunk))
  stream.on('end', () => message.emit('end'))
  stream.on('error', (err) => message.emit('error', err))
  // Re-implement read() so Koa's body parser sees the data.
  ;(message as unknown as { _read: () => void })._read = () => {
    stream.resume()
  }
  // Also expose the buffered payload synchronously for any consumer that
  // reads `rawBody`.
  ;(message as unknown as { rawBody: Buffer }).rawBody = bodyBuffer

  return message
}

interface CapturedResponse {
  status: number
  headers: Record<string, string | string[]>
  body: Buffer
}

function buildServerResponse(
  req: IncomingMessage,
  resolve: (value: CapturedResponse) => void,
): ServerResponse {
  const res = new ServerResponse(req)
  const chunks: Buffer[] = []

  const originalWrite = res.write.bind(res)
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk != null) {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as string, (rest[0] as BufferEncoding) || 'utf8'),
      )
    }
    return originalWrite(chunk as Parameters<typeof originalWrite>[0], ...(rest as []))
  }) as typeof res.write

  const originalEnd = res.end.bind(res)
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (chunk != null && typeof chunk !== 'function') {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as string, (rest[0] as BufferEncoding) || 'utf8'),
      )
    }
    const headers = res.getHeaders() as Record<string, string | string[]>
    resolve({
      status: res.statusCode,
      headers,
      body: Buffer.concat(chunks),
    })
    return originalEnd(chunk as Parameters<typeof originalEnd>[0], ...(rest as []))
  }) as typeof res.end

  return res
}

async function handle(req: Request): Promise<Response> {
  const provider = await getOidcProvider()
  const callback = provider.callback()

  const incoming = await buildIncomingMessage(req)

  const captured = await new Promise<CapturedResponse>((resolve, reject) => {
    const outgoing = buildServerResponse(incoming, resolve)
    outgoing.on('error', reject)
    try {
      const maybe = callback(incoming, outgoing) as unknown
      if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
        ;(maybe as Promise<unknown>).catch(reject)
      }
    } catch (err) {
      reject(err)
    }
  })

  // Convert captured Node headers to a Web `Headers` object. Drop panva's CORS
  // headers: the /api/* middleware is the only CORS owner (src/middleware.ts),
  // so there is no duplicate Access-Control-Allow-Origin, and panva's open
  // CORS on discovery / jwks cannot echo `Origin: null`.
  const responseHeaders = new Headers()
  for (const [name, value] of Object.entries(captured.headers)) {
    const lower = name.toLowerCase()
    if (lower.startsWith('access-control-') || lower === 'vary') continue
    if (Array.isArray(value)) {
      for (const v of value) {
        responseHeaders.append(name, String(v))
      }
    } else if (value != null) {
      responseHeaders.set(name, String(value))
    }
  }

  // Copy into a freshly-allocated ArrayBuffer-backed Uint8Array — Node's
  // Buffer is typed with `ArrayBufferLike` while the DOM `BodyInit` types
  // want a plain `ArrayBuffer`, so we can't just hand the Buffer over even
  // though it works at runtime.
  const ab = new ArrayBuffer(captured.body.byteLength)
  new Uint8Array(ab).set(captured.body)
  return new Response(ab, {
    status: captured.status,
    headers: responseHeaders,
  })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const DELETE = handle
export const PATCH = handle
export const HEAD = handle
