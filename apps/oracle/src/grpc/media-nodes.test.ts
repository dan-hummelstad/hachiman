/**
 * Integration tests for the media-nodes handlers.
 *
 * Exercises the REAL registerMediaNode + mediaNodeHeartbeat handlers against
 * an InMemoryMediaNodesRepo — same wire-shape assertions as before, but the
 * code path under test is now production-shipping code rather than a
 * shadow fake. The DB substitution happens at the MediaNodesRepo seam (see
 * repo.ts), which keeps the test free of DATABASE_URL while still
 * exercising the validation surface, status transitions, and
 * partition-recovery tenant preservation that production cares about.
 *
 * Run via `pnpm -F @hachiman/oracle test:grpc`.
 */
import assert from 'node:assert/strict'
import * as grpc from '@grpc/grpc-js'

import { mediaNodeHeartbeat, registerMediaNode } from './media-nodes'
import { placeMediaSession } from './placement'
import type {
  MediaNodeHeartbeatRequest,
  MediaNodeHeartbeatResponse,
  PlaceMediaSessionRequest,
  PlaceMediaSessionResponse,
  RegisterMediaNodeRequest,
  RegisterMediaNodeResponse,
} from './proto'
import { InMemoryMediaNodesRepo } from './repo.in-memory'

// --- tiny test harness ------------------------------------------------------
let passed = 0
const failures: string[] = []
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.replace(/\n/g, '\n    ')}`)
  }
}

// --- handler-invocation shims ----------------------------------------------
// gRPC's ServerUnaryCall is a complex type; we only need the .request field.
// The callback shape matches grpc.sendUnaryData so the real handlers are
// happy passing it through.

interface HandlerResult<Resp> {
  code: grpc.status
  message?: string
  resp?: Resp
}

async function invokeRegister(
  repo: InMemoryMediaNodesRepo,
  req: RegisterMediaNodeRequest,
): Promise<HandlerResult<RegisterMediaNodeResponse>> {
  return new Promise((resolve) => {
    const call = { request: req } as unknown as grpc.ServerUnaryCall<
      RegisterMediaNodeRequest,
      RegisterMediaNodeResponse
    >
    void registerMediaNode(
      call,
      (err, value) => {
        if (err) {
          const e = err as { code?: grpc.status; message?: string }
          resolve({ code: e.code ?? grpc.status.UNKNOWN, message: e.message })
        } else {
          resolve({ code: grpc.status.OK, resp: value as RegisterMediaNodeResponse })
        }
      },
      repo,
    )
  })
}

async function invokeHeartbeat(
  repo: InMemoryMediaNodesRepo,
  req: MediaNodeHeartbeatRequest,
): Promise<HandlerResult<MediaNodeHeartbeatResponse>> {
  return new Promise((resolve) => {
    const call = { request: req } as unknown as grpc.ServerUnaryCall<
      MediaNodeHeartbeatRequest,
      MediaNodeHeartbeatResponse
    >
    void mediaNodeHeartbeat(
      call,
      (err, value) => {
        if (err) {
          const e = err as { code?: grpc.status; message?: string }
          resolve({ code: e.code ?? grpc.status.UNKNOWN, message: e.message })
        } else {
          resolve({ code: grpc.status.OK, resp: value as MediaNodeHeartbeatResponse })
        }
      },
      repo,
    )
  })
}

async function invokePlace(
  repo: InMemoryMediaNodesRepo,
  req: PlaceMediaSessionRequest,
): Promise<HandlerResult<PlaceMediaSessionResponse>> {
  return new Promise((resolve) => {
    const call = { request: req } as unknown as grpc.ServerUnaryCall<
      PlaceMediaSessionRequest,
      PlaceMediaSessionResponse
    >
    void placeMediaSession(
      call,
      (err, value) => {
        if (err) {
          const e = err as { code?: grpc.status; message?: string }
          resolve({ code: e.code ?? grpc.status.UNKNOWN, message: e.message })
        } else {
          resolve({ code: grpc.status.OK, resp: value as PlaceMediaSessionResponse })
        }
      },
      repo,
    )
  })
}

// --- compile-time guards ----------------------------------------------------
// Confirm the response type shapes line up with the proto interface
// declarations — if a field is removed/renamed in proto.ts the assignment
// below stops compiling.
const _registerResp: RegisterMediaNodeResponse = {}
const _heartbeatResp: MediaNodeHeartbeatResponse = {}
const _placeResp: PlaceMediaSessionResponse = { node_id: '', addr: '', assigned_ssrc: 0 }
void _registerResp
void _heartbeatResp
void _placeResp

// --- tests ------------------------------------------------------------------

async function main() {
  const repo = new InMemoryMediaNodesRepo()

  await test('RegisterMediaNode happy path inserts a row', async () => {
    const r = await invokeRegister(repo, {
      node_id: 'node-1',
      region: 'us-east',
      sidechannel_addr: '10.0.0.1:7881',
      max_sessions: 200,
      version: 'test-1.0',
    })
    assert.equal(r.code, grpc.status.OK)
    assert.ok(repo.rows.has('node-1'))
    assert.equal(repo.rows.get('node-1')?.region, 'us-east')
    assert.equal(repo.rows.get('node-1')?.sidechannelAddr, '10.0.0.1:7881')
  })

  await test('RegisterMediaNode rejects empty node_id', async () => {
    const r = await invokeRegister(repo, {
      node_id: '',
      region: 'us-east',
      sidechannel_addr: '',
      max_sessions: 0,
      version: '',
    })
    assert.equal(r.code, grpc.status.INVALID_ARGUMENT)
  })

  await test('RegisterMediaNode rejects empty region', async () => {
    const r = await invokeRegister(repo, {
      node_id: 'node-x',
      region: '',
      sidechannel_addr: '',
      max_sessions: 0,
      version: '',
    })
    assert.equal(r.code, grpc.status.INVALID_ARGUMENT)
  })

  await test('RegisterMediaNode preserves tenantId on re-register (partition recovery)', async () => {
    // Seed a row that's already tenant-bound. A subsequent register from
    // the same node_id (e.g. after a network partition + reconnect) must
    // not clear that binding — otherwise a different tenant could land on
    // the same node mid-session.
    repo.seed({
      nodeId: 'node-2',
      region: 'us-east',
      tenantId: 'tenant-x',
      activeSessions: 5,
    })
    const r = await invokeRegister(repo, {
      node_id: 'node-2',
      region: 'us-east',
      sidechannel_addr: '10.0.0.2:7881',
      max_sessions: 100,
      version: 'test-1.0',
    })
    assert.equal(r.code, grpc.status.OK)
    assert.equal(repo.rows.get('node-2')?.tenantId, 'tenant-x')
  })

  await test('MediaNodeHeartbeat happy path updates the row', async () => {
    await invokeRegister(repo, {
      node_id: 'node-3',
      region: 'us-east',
      sidechannel_addr: '',
      max_sessions: 100,
      version: '',
    })
    const r = await invokeHeartbeat(repo, {
      node_id: 'node-3',
      active_sessions: 12,
      cpu_fraction: 0.3,
      accepting: true,
    })
    assert.equal(r.code, grpc.status.OK)
    assert.equal(repo.rows.get('node-3')?.activeSessions, 12)
    assert.equal(repo.rows.get('node-3')?.status, 'active')
  })

  await test('MediaNodeHeartbeat returns NOT_FOUND for unregistered node', async () => {
    const r = await invokeHeartbeat(repo, {
      node_id: 'ghost',
      active_sessions: 0,
      cpu_fraction: 0,
      accepting: true,
    })
    assert.equal(r.code, grpc.status.NOT_FOUND)
  })

  await test('MediaNodeHeartbeat rejects empty node_id', async () => {
    const r = await invokeHeartbeat(repo, {
      node_id: '',
      active_sessions: 0,
      cpu_fraction: 0,
      accepting: true,
    })
    assert.equal(r.code, grpc.status.INVALID_ARGUMENT)
  })

  await test('MediaNodeHeartbeat accepting=false transitions to draining', async () => {
    await invokeRegister(repo, {
      node_id: 'node-4',
      region: 'us-east',
      sidechannel_addr: '',
      max_sessions: 100,
      version: '',
    })
    await invokeHeartbeat(repo, {
      node_id: 'node-4',
      active_sessions: 5,
      cpu_fraction: 0.4,
      accepting: false,
    })
    assert.equal(repo.rows.get('node-4')?.status, 'draining')
  })

  await test('PlaceMediaSession rejects empty home_region', async () => {
    const r = await invokePlace(repo, { channel_id: 1, home_region: '', tenant_id: '' })
    assert.equal(r.code, grpc.status.INVALID_ARGUMENT)
  })

  await test('PlaceMediaSession RESOURCE_EXHAUSTED on empty store', async () => {
    const emptyRepo = new InMemoryMediaNodesRepo()
    const r = await invokePlace(emptyRepo, {
      channel_id: 1,
      home_region: 'us-east',
      tenant_id: '',
    })
    assert.equal(r.code, grpc.status.RESOURCE_EXHAUSTED)
  })

  await test('PlaceMediaSession returns a node when at least one matches the region', async () => {
    // node-3 was registered above + heartbeat applied; it's still in the
    // repo. Place against the same region.
    const r = await invokePlace(repo, {
      channel_id: 1,
      home_region: 'us-east',
      tenant_id: '',
    })
    assert.equal(r.code, grpc.status.OK)
    assert.ok(r.resp)
    assert.notEqual(r.resp?.node_id, '')
    // Phase 3a: assigned_ssrc is 0; locked in here so a future change
    // surfaces in code review.
    assert.equal(r.resp?.assigned_ssrc, 0)
  })

  if (failures.length === 0) {
    console.log(`media-nodes: ${passed} tests passed`)
  } else {
    console.log(`media-nodes: ${passed} tests passed, ${failures.length} failed`)
    for (const f of failures) console.error('  FAIL', f)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('media-nodes test runner crashed:', err)
  process.exit(1)
})
