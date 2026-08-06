/**
 * PlaceMediaSession — picks a live media node in the requested home_region
 * subject to:
 *
 *  - heartbeat freshness (status='active', lastHeartbeatAt within
 *    HEARTBEAT_STALE_AFTER_MS of now);
 *  - single-tenant-per-node (a non-null tenant_id on the row must match the
 *    incoming request's tenant_id);
 *  - lowest-loaded-first ranking via heartbeat-reported active_sessions
 *    ascending (phase 3a: heartbeat-reported value, not a derived aggregate).
 *
 * On placement: stamps the winning row's tenant_id with the request's
 * tenant_id via an atomic conditional UPDATE … RETURNING. Two concurrent
 * placements for different tenants racing on the same NULL-tenant node
 * cannot both succeed — the WHERE clause guards against the second one
 * silently overwriting the first. When the UPDATE returns zero rows we
 * surface RESOURCE_EXHAUSTED so control's callsite falls back to its local
 * pickNode() (see choosePlacement in cmd/hachiman-control/webrtc_handlers.go).
 *
 * Returns RESOURCE_EXHAUSTED if no candidates pass the filters OR if the
 * winning candidate got stamped by a concurrent request between SELECT and
 * UPDATE.
 *
 * SSRC: phase 3a echoes a deterministic value derived from (node_id, now())
 * rather than allocating a fresh uint32 — the proto already documents that
 * media validates `assigned_ssrc` against what the client publishes, and the
 * control side currently uses the Mumble session id as SSRC (CRITICAL #1 in
 * the phase-1 BLOCK fix-pass). For phase 3a we return 0; control's
 * choosePlacement helper carries forward the assigned_ssrc but it isn't used
 * for routing today. The proto field's value lands when phase 4 wires the
 * VoiceTokenGrant claim end-to-end.
 *
 * Testability: the SQL access lives behind the MediaNodesRepo interface
 * (see ./repo.ts). Production wires Drizzle via drizzleMediaNodesRepo; tests
 * inject an in-memory implementation that mirrors the Postgres contract.
 * That keeps the production SQL canonical and exercised by the behavioural
 * test cases, rather than tested separately from a shadow implementation.
 */
import * as grpc from '@grpc/grpc-js'

import {
  drizzleMediaNodesRepo,
  type MediaNodesRepo,
  type PlacementCandidate,
} from './repo'
import type { PlaceMediaSessionRequest, PlaceMediaSessionResponse } from './proto'

/** Heartbeat freshness window. Per the management.proto comment, Oracle
 *  excludes nodes that miss 3 consecutive heartbeats from placement.
 *  hachiman-media heartbeats every 10s; 30s + grace is the canonical window. */
export const HEARTBEAT_STALE_AFTER_MS = 30_000

export type { PlacementCandidate, MediaNodesRepo }

export interface PickPlacementOptions {
  homeRegion: string
  tenantId: string
  now: Date
}

export async function placeMediaSession(
  call: grpc.ServerUnaryCall<PlaceMediaSessionRequest, PlaceMediaSessionResponse>,
  callback: grpc.sendUnaryData<PlaceMediaSessionResponse>,
  repo: MediaNodesRepo = drizzleMediaNodesRepo,
): Promise<void> {
  const req = call.request
  if (!req.home_region) {
    callback(
      { code: grpc.status.INVALID_ARGUMENT, message: 'home_region is required' },
      null,
    )
    return
  }
  try {
    const node = await pickPlacement(
      {
        homeRegion: req.home_region,
        tenantId: req.tenant_id ?? '',
        now: new Date(),
      },
      repo,
    )
    if (!node) {
      callback(
        {
          code: grpc.status.RESOURCE_EXHAUSTED,
          message: `no media nodes available in region ${req.home_region}`,
        },
        null,
      )
      return
    }
    callback(null, {
      node_id: node.nodeId,
      addr: node.sidechannelAddr ?? '',
      // assigned_ssrc: 0 in phase 3a — see file header rationale.
      assigned_ssrc: 0,
    })
  } catch (err) {
    callback(
      {
        code: grpc.status.INTERNAL,
        message: `PlaceMediaSession failed: ${(err as Error).message}`,
      },
      null,
    )
  }
}

/**
 * Pick a placement candidate via repo.findEligibleCandidate followed (when
 * a tenant is supplied) by an atomic conditional stamp via repo.stampTenant.
 *
 * Two-phase by necessity: the find identifies the lowest-loaded eligible
 * node, the conditional stamp claims it only if still claim-eligible
 * (tenant_id IS NULL or already matches). If the stamp returns undefined a
 * concurrent placement won the race; we return undefined and the caller
 * surfaces RESOURCE_EXHAUSTED so control falls back to local pickNode().
 *
 * Note: the find-then-stamp pattern leaves room for livelock if many tenants
 * race on the same handful of free nodes — phase 4 revisits with a single
 * round-trip `SELECT … FOR UPDATE SKIP LOCKED` once the placement index
 * (idx_media_nodes_placement) is in place and the volume justifies the
 * extra complexity. For now: simple, correct under contention, and the
 * caller's fallback masks the occasional loser.
 */
export async function pickPlacement(
  opts: PickPlacementOptions,
  repo: MediaNodesRepo = drizzleMediaNodesRepo,
): Promise<PlacementCandidate | undefined> {
  const staleCutoff = new Date(opts.now.getTime() - HEARTBEAT_STALE_AFTER_MS)
  const candidate = await repo.findEligibleCandidate({
    region: opts.homeRegion,
    tenantId: opts.tenantId,
    staleCutoff,
  })
  if (!candidate) return undefined

  // No tenant => no stamp. Stamping NULL would erase any existing binding
  // we want to keep.
  if (opts.tenantId === '') {
    return candidate
  }
  // Already-our-tenant: idempotent. Skip the UPDATE so we don't bump
  // updated_at / generate WAL for the no-op. The single-tenant rule was
  // enforced by findEligibleCandidate; a mismatched tenant would never
  // have come back.
  if (candidate.tenantId === opts.tenantId) {
    return candidate
  }

  // Atomic conditional stamp via UPDATE … WHERE tenant_id IS NULL OR
  // tenant_id = $newTenant … RETURNING. Two concurrent placements for
  // different tenants targeting the same NULL-tenant node cannot both win:
  // whichever UPDATE lands first stamps; the second matches zero rows and
  // returns undefined. Caller surfaces RESOURCE_EXHAUSTED and control
  // re-tries locally.
  return repo.stampTenant({
    nodeId: candidate.nodeId,
    tenantId: opts.tenantId,
  })
}
