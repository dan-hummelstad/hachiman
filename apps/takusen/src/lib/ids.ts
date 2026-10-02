import { NotFoundError } from '@/lib/errors'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Route params are untrusted: a non-UUID would make Postgres throw (→ 500). */
export function assertId(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw new NotFoundError(`Unknown ${what}`)
  return id
}
