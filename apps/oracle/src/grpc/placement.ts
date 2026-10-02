/**
 * PlaceMediaSession — picks a live media node in the requested home_region (any region when empty):
 *
 *  - heartbeat freshness (status='active', lastHeartbeatAt within
 *    HEARTBEAT_STALE_AFTER_MS of now);
 *  - lowest-loaded-first ranking via heartbeat-reported active_sessions
 *    ascending, ties broken by node_id.
 *
 * The gateway calls this only when a voice channel has no node yet; it keeps
 * channel→node stickiness itself in Redis `voice_room:{channelId}`, so every
 * user in a channel lands on the same node. `channel_id` / `guild_id` are
 * accepted per the contract but don't influence the pick today.
 *
 * Returns RESOURCE_EXHAUSTED if no candidates pass the filters.
 *
 * Testability: the SQL access lives behind the MediaNodesRepo interface
 * (see ./repo.ts). Production wires Drizzle via drizzleMediaNodesRepo; tests
 * inject an in-memory implementation that mirrors the Postgres contract.
 */
import * as grpc from '@grpc/grpc-js'

import {
  drizzleMediaNodesRepo,
  type MediaNodesRepo,
  type PlacementCandidate,
} from './repo'
import type { PlaceMediaSessionRequest, PlaceMediaSessionResponse } from './proto'

/** Heartbeat freshness window. Oracle excludes nodes that miss 3 consecutive
 *  heartbeats from placement. hachiman-media heartbeats every 10s. */
export const HEARTBEAT_STALE_AFTER_MS = 30_000

export type { PlacementCandidate, MediaNodesRepo }

export interface PickPlacementOptions {
  homeRegion: string
  now: Date
}

export async function placeMediaSession(
  call: grpc.ServerUnaryCall<PlaceMediaSessionRequest, PlaceMediaSessionResponse>,
  callback: grpc.sendUnaryData<PlaceMediaSessionResponse>,
  repo: MediaNodesRepo = drizzleMediaNodesRepo,
): Promise<void> {
  const req = call.request
  try {
    const node = await pickPlacement({ homeRegion: req.home_region, now: new Date() }, repo)
    if (!node) {
      callback(
        {
          code: grpc.status.RESOURCE_EXHAUSTED,
          message: `no media nodes available in region ${req.home_region || '(any)'}`,
        },
        null,
      )
      return
    }
    callback(null, { node_id: node.nodeId, signaling_url: node.signalingUrl })
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

export async function pickPlacement(
  opts: PickPlacementOptions,
  repo: MediaNodesRepo = drizzleMediaNodesRepo,
): Promise<PlacementCandidate | undefined> {
  const staleCutoff = new Date(opts.now.getTime() - HEARTBEAT_STALE_AFTER_MS)
  return repo.findEligibleCandidate({ region: opts.homeRegion, staleCutoff })
}
