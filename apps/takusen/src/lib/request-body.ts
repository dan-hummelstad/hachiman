/**
 * The raw request body, read once and cached per request. The device proof (lib/mls/device-proof.ts)
 * hashes these exact bytes, and parseBody parses them, so the two can run in either order.
 */
const bodies = new WeakMap<Request, Uint8Array>()

export async function readRawBody(req: Request): Promise<Uint8Array> {
  const cached = bodies.get(req)
  if (cached) return cached
  if (req.bodyUsed) throw new Error('readRawBody: the body was consumed outside readRawBody')
  const bytes = new Uint8Array(await req.arrayBuffer())
  bodies.set(req, bytes)
  return bytes
}
