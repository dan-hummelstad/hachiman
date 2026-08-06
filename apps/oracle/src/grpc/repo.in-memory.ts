/**
 * In-memory MediaNodesRepo for tests. Mirrors the production Drizzle
 * implementation in repo.ts behaviour-for-behaviour: same filter rules,
 * same ordering, same "no stamp on lost race" semantics.
 *
 * Why a shared in-memory impl: every test file that exercises the handlers
 * would otherwise reinvent this. Reviewed pattern: filter/rank lives in
 * exactly two places (Drizzle SQL + this in-memory translation); behavioural
 * tests run against this, the SQL contract is locked in by .toSQL()
 * snapshots in placement.test.ts.
 */
import type {
  FindEligibleCandidateInput,
  HeartbeatMediaNodeInput,
  MediaNodesRepo,
  PlacementCandidate,
  StampTenantInput,
  UpsertMediaNodeInput,
} from './repo'

export interface InMemoryNodeRow {
  nodeId: string
  region: string
  capacity: { cpu_cores: number; max_sessions: number }
  activeSessions: number
  cpuFraction: number
  lastHeartbeatAt: Date
  version: string
  status: 'active' | 'draining' | 'dead'
  tenantId: string | null
  sidechannelAddr: string
}

export class InMemoryMediaNodesRepo implements MediaNodesRepo {
  public readonly rows = new Map<string, InMemoryNodeRow>()

  /** Seed helper for tests; mirrors what production rows look like after a
   *  register + a heartbeat or two. */
  seed(node: Partial<InMemoryNodeRow> & { nodeId: string }): InMemoryNodeRow {
    const row: InMemoryNodeRow = {
      nodeId: node.nodeId,
      region: node.region ?? 'us-east',
      capacity: node.capacity ?? { cpu_cores: 0, max_sessions: 100 },
      activeSessions: node.activeSessions ?? 0,
      cpuFraction: node.cpuFraction ?? 0,
      lastHeartbeatAt: node.lastHeartbeatAt ?? new Date(),
      version: node.version ?? 'test-1.0',
      status: node.status ?? 'active',
      tenantId: node.tenantId ?? null,
      sidechannelAddr: node.sidechannelAddr ?? '',
    }
    this.rows.set(row.nodeId, row)
    return row
  }

  private toCandidate(r: InMemoryNodeRow): PlacementCandidate {
    return {
      nodeId: r.nodeId,
      sidechannelAddr: r.sidechannelAddr,
      tenantId: r.tenantId,
      activeSessions: r.activeSessions,
      region: r.region,
      status: r.status,
      lastHeartbeatAt: r.lastHeartbeatAt,
    }
  }

  async findEligibleCandidate(
    input: FindEligibleCandidateInput,
  ): Promise<PlacementCandidate | undefined> {
    const eligible = [...this.rows.values()].filter((r) => {
      if (r.region !== input.region) return false
      if (r.status !== 'active') return false
      // Strict gt — matches Drizzle's gt(), excludes the cutoff itself.
      if (r.lastHeartbeatAt.getTime() <= input.staleCutoff.getTime()) return false
      if (input.tenantId !== '') {
        if (r.tenantId !== null && r.tenantId !== input.tenantId) return false
      }
      return true
    })
    eligible.sort((a, b) => {
      if (a.activeSessions !== b.activeSessions) {
        return a.activeSessions - b.activeSessions
      }
      return a.nodeId.localeCompare(b.nodeId)
    })
    const r = eligible[0]
    if (!r) return undefined
    return this.toCandidate(r)
  }

  async stampTenant(input: StampTenantInput): Promise<PlacementCandidate | undefined> {
    const r = this.rows.get(input.nodeId)
    if (!r) return undefined
    // CRITICAL #2 contract: stamp only when tenant_id IS NULL OR
    // tenant_id = newTenant. Concurrent stamps from a different tenant
    // see this guard fail and the second caller gets undefined.
    if (r.tenantId !== null && r.tenantId !== input.tenantId) {
      return undefined
    }
    r.tenantId = input.tenantId
    return this.toCandidate(r)
  }

  async upsertMediaNode(input: UpsertMediaNodeInput): Promise<void> {
    const existing = this.rows.get(input.nodeId)
    this.rows.set(input.nodeId, {
      nodeId: input.nodeId,
      region: input.region,
      capacity: input.capacity,
      activeSessions: existing?.activeSessions ?? 0,
      cpuFraction: existing?.cpuFraction ?? 0,
      lastHeartbeatAt: input.lastHeartbeatAt,
      version: input.version,
      status: 'active',
      // tenantId preserved across re-register — guards against a partition
      // recovery clearing the tenant binding mid-session. Matches the
      // production onConflictDoUpdate.set spec.
      tenantId: existing?.tenantId ?? null,
      sidechannelAddr: input.sidechannelAddr,
    })
  }

  async applyHeartbeat(input: HeartbeatMediaNodeInput): Promise<boolean> {
    const r = this.rows.get(input.nodeId)
    if (!r) return false
    r.lastHeartbeatAt = input.lastHeartbeatAt
    r.activeSessions = input.activeSessions
    r.cpuFraction = input.cpuFraction
    // Mirrors the CASE WHEN in repo.ts:
    //   dead → dead (stays dead; sweeper-only revival)
    //   accepting=true → active
    //   accepting=false → draining
    if (r.status !== 'dead') {
      r.status = input.accepting ? 'active' : 'draining'
    }
    return true
  }
}
