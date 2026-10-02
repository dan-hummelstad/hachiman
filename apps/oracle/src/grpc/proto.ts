/**
 * gRPC proto loader. Loads `apps/hachiman-server/pkg/management/management.proto`
 * via `@grpc/proto-loader` so the Go server and TS server agree on the wire by
 * pointing at the same proto source file. No generated TS bindings — the
 * dynamic loader covers the small RPC surface we expose.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

// __dirname under ESM. This file lives at apps/oracle/src/grpc/proto.ts; the
// proto source is at apps/hachiman-server/pkg/management/management.proto.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const MANAGEMENT_PROTO_PATH = resolve(
  __dirname,
  '../../../hachiman-server/pkg/management/management.proto',
)

/** Per @grpc/proto-loader defaults the package descriptor type isn't materialised
 *  at compile time — cast at the boundary so callers see strongly-typed message
 *  shapes. */
export interface RegisterMediaNodeRequest {
  node_id: string
  region: string
  signaling_url: string
  max_sessions: number
  version: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type RegisterMediaNodeResponse = {
  /* empty per proto */
}

export interface MediaNodeHeartbeatRequest {
  node_id: string
  active_sessions: number
  cpu_fraction: number
  accepting: boolean
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type MediaNodeHeartbeatResponse = {
  /* empty per proto */
}

export interface PlaceMediaSessionRequest {
  channel_id: string
  home_region: string
  guild_id: string
}

export interface PlaceMediaSessionResponse {
  node_id: string
  signaling_url: string
}

/** Service handlers for `hachiman.management.v1.Management`. Oracle serves
 *  all three RPCs; hachiman-media and hachiman-gateway call them. */
export type ManagementHandlers = {
  RegisterMediaNode: grpc.handleUnaryCall<RegisterMediaNodeRequest, RegisterMediaNodeResponse>
  MediaNodeHeartbeat: grpc.handleUnaryCall<MediaNodeHeartbeatRequest, MediaNodeHeartbeatResponse>
  PlaceMediaSession: grpc.handleUnaryCall<PlaceMediaSessionRequest, PlaceMediaSessionResponse>
}

/** Lazily-loaded service descriptor. Loaded once per process; cached on the
 *  module so a hot-reload doesn't re-parse the proto on every call. */
let serviceDescriptor: grpc.ServiceDefinition | null = null

export function loadManagementService(): grpc.ServiceDefinition {
  if (serviceDescriptor) return serviceDescriptor
  const packageDefinition = protoLoader.loadSync(MANAGEMENT_PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  const grpcObject = grpc.loadPackageDefinition(packageDefinition)
  // Drill into hachiman.management.v1.Management.service per the package
  // directive in management.proto.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ns = (grpcObject as any).hachiman?.management?.v1?.Management
  if (!ns || !ns.service) {
    throw new Error('loadManagementService: Management service not found in proto')
  }
  serviceDescriptor = ns.service as grpc.ServiceDefinition
  return serviceDescriptor
}
