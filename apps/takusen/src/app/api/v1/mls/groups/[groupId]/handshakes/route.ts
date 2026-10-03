/**
 * GET /api/v1/mls/groups/:groupId/handshakes?after=&limit= → {handshakes, latestSeq}.
 * `limit` ≤ 200 (default 100). 410 HandshakesExpired (§12.7.9).
 */
import { fetchHandshakes, HANDSHAKES_DEFAULT_LIMIT, HANDSHAKES_MAX_LIMIT } from '@/lib/mls/device-data'
import { parseGroupIdParam } from '@/lib/mls/groups'
import { dsRoute, intQuery, json } from '@/lib/mls/route'

export const GET = dsRoute<{ groupId: string }>('active', async (ctx) => {
  const q = ctx.req.nextUrl.searchParams
  const after = intQuery(q, 'after', 0)
  const limit = intQuery(q, 'limit', HANDSHAKES_DEFAULT_LIMIT, HANDSHAKES_MAX_LIMIT) || HANDSHAKES_DEFAULT_LIMIT
  return json(await fetchHandshakes(ctx.repo, ctx.userId, parseGroupIdParam(ctx.params.groupId), after, limit))
})
