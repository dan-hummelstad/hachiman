/**
 * RegisterMediaNode + MediaNodeHeartbeat — Oracle-side implementations of the
 * media-plane RPCs from management.proto.
 *
 * Both delegate storage to the MediaNodesRepo seam (see ./repo.ts).
 * RegisterMediaNode upserts on `node_id`; MediaNodeHeartbeat updates an
 * existing row's heartbeat counters and returns NOT_FOUND if no row exists
 * (control must have RegisterMediaNode'd first).
 *
 * Errors are surfaced as gRPC status codes (`code` field on the callback err)
 * so the Go side's `errors.Is` / `status.Code` checks work. Per phase 3a
 * scope, lifecycle status starts at `active` on first sight and stays there
 * until an explicit drain path lands (phase 3b / 4).
 */
import * as grpc from '@grpc/grpc-js'

import { drizzleMediaNodesRepo, type MediaNodesRepo } from './repo'

import type {
  MediaNodeHeartbeatRequest,
  MediaNodeHeartbeatResponse,
  RegisterMediaNodeRequest,
  RegisterMediaNodeResponse,
} from './proto'

/** Default capacity descriptor stamped on first register. The wire only
 *  carries `max_sessions`; cpu_cores is unknown until we add a probe (phase
 *  4). Stored as JSONB so the descriptor can grow without a schema change. */
function buildCapacity(req: RegisterMediaNodeRequest): {
  cpu_cores: number
  max_sessions: number
} {
  return {
    cpu_cores: 0,
    max_sessions: req.max_sessions ?? 0,
  }
}

export async function registerMediaNode(
  call: grpc.ServerUnaryCall<RegisterMediaNodeRequest, RegisterMediaNodeResponse>,
  callback: grpc.sendUnaryData<RegisterMediaNodeResponse>,
  repo: MediaNodesRepo = drizzleMediaNodesRepo,
): Promise<void> {
  const req = call.request
  if (!req.node_id) {
    callback({ code: grpc.status.INVALID_ARGUMENT, message: 'node_id is required' }, null)
    return
  }
  if (!req.region) {
    callback({ code: grpc.status.INVALID_ARGUMENT, message: 'region is required' }, null)
    return
  }
  try {
    await repo.upsertMediaNode({
      nodeId: req.node_id,
      region: req.region,
      capacity: buildCapacity(req),
      lastHeartbeatAt: new Date(),
      version: req.version ?? '',
      sidechannelAddr: req.sidechannel_addr ?? '',
    })
    callback(null, {})
  } catch (err) {
    callback(
      {
        code: grpc.status.INTERNAL,
        message: `RegisterMediaNode failed: ${(err as Error).message}`,
      },
      null,
    )
  }
}

export async function mediaNodeHeartbeat(
  call: grpc.ServerUnaryCall<MediaNodeHeartbeatRequest, MediaNodeHeartbeatResponse>,
  callback: grpc.sendUnaryData<MediaNodeHeartbeatResponse>,
  repo: MediaNodesRepo = drizzleMediaNodesRepo,
): Promise<void> {
  const req = call.request
  if (!req.node_id) {
    callback({ code: grpc.status.INVALID_ARGUMENT, message: 'node_id is required' }, null)
    return
  }
  try {
    const found = await repo.applyHeartbeat({
      nodeId: req.node_id,
      lastHeartbeatAt: new Date(),
      activeSessions: req.active_sessions ?? 0,
      cpuFraction: req.cpu_fraction ?? 0,
      accepting: req.accepting ?? false,
    })
    if (!found) {
      callback(
        {
          code: grpc.status.NOT_FOUND,
          message: `node ${req.node_id} is not registered (call RegisterMediaNode first)`,
        },
        null,
      )
      return
    }
    callback(null, {})
  } catch (err) {
    callback(
      {
        code: grpc.status.INTERNAL,
        message: `MediaNodeHeartbeat failed: ${(err as Error).message}`,
      },
      null,
    )
  }
}
