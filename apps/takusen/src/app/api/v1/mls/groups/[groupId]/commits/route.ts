/**
 * POST /api/v1/mls/groups/:groupId/commits CommitRequest → {epoch, seq} (201).
 * `rejected[]` names a join by `pendingId` or a DS Add proposal of the batch by
 * `proposalRef` (BatchRejection). `rejectedProposals` (optional) is the older
 * form of the second kind. Both kinds are marked rejected in the transaction of
 * the commit. Body schema: lib/mls/schemas.ts.
 * 409 EpochConflict {epoch}. MLS_HANDSHAKE; DEVICE_INBOX per Welcome (§12.7.3).
 *
 * Middleware skips this path (the body can be above its 10 MB limit, see
 * src/middleware.ts), so CORS is applied here.
 */
import { corsPreflight, withCors } from '@/lib/cors'
import { uploadCommit } from '@/lib/mls/commits'
import { rateLimitDevice } from '@/lib/mls/context'
import { parseGroupIdParam } from '@/lib/mls/groups'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'
import { commitRequestSchema, splitRejections } from '@/lib/mls/schemas'

export const POST = withCors(
  dsRoute<{ groupId: string }>('active', async (ctx) => {
    const device = requireRouteDevice(ctx)
    const groupId = parseGroupIdParam(ctx.params.groupId)
    const deps = await ctx.deps()
    await rateLimitDevice(deps, 'commits', device)
    const b = await body(ctx.req, commitRequestSchema)
    return json(await uploadCommit(ctx.repo, deps, ctx.out, { userId: ctx.userId, device }, groupId, { ...b, ...splitRejections(b) }), 201)
  }),
)

export const OPTIONS = corsPreflight
