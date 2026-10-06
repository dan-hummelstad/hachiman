/**
 * InviteHistoryStore in memory, for tests (invite-history.ts). The same rules
 * as drizzleInviteHistoryStore: invite-history.conformance.ts runs on both.
 */
import { randomUUID } from 'node:crypto'

import type { InviteBundleRow, InviteRow } from '@/db/schema'

import { isInviteActive, type InviteHistoryStore, type NewInviteBundle, type StoredInviteRecord } from './invite-history'

const compareBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b))

export class InMemoryInviteHistoryStore implements InviteHistoryStore {
  readonly invites = new Map<string, InviteRow>()
  /** `${guildId}:${userId}` → the membership. */
  readonly members = new Map<string, { inviteId: string | null; joinedAt: Date }>()
  /** Oldest first. */
  bundles: InviteBundleRow[] = []

  /** Test seeding: an invite row. Default: no record, no expiry, no use limit. */
  addInvite(i: Partial<InviteRow> & Pick<InviteRow, 'guildId' | 'createdBy'>): InviteRow {
    const row: InviteRow = {
      id: randomUUID(),
      code: randomUUID().slice(0, 8).toUpperCase(),
      expiresAt: null,
      maxUses: null,
      uses: 0,
      revoked: false,
      record: null,
      keyId: null,
      exhaustedAt: null,
      createdAt: new Date(),
      ...i,
    }
    this.invites.set(row.id, row)
    return row
  }

  addMember(guildId: string, userId: string, join: { inviteId: string | null; joinedAt: Date } = { inviteId: null, joinedAt: new Date() }): void {
    this.members.set(`${guildId}:${userId}`, join)
  }

  async transaction<T>(fn: (store: InviteHistoryStore) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async getInvite(id: string): Promise<InviteRow | null> {
    return this.invites.get(id) ?? null
  }

  async joinWithInvite(invite: InviteRow, userId: string, now: Date): Promise<void> {
    const key = `${invite.guildId}:${userId}`
    if (this.members.has(key)) throw new Error('duplicate membership')
    this.members.set(key, { inviteId: invite.id, joinedAt: now })
    const row = this.invites.get(invite.id)!
    row.uses = invite.uses + 1
    if (invite.maxUses !== null && row.uses >= invite.maxUses) row.exhaustedAt = now
  }

  async memberJoin(guildId: string, userId: string): Promise<{ inviteId: string | null; joinedAt: Date } | null> {
    return this.members.get(`${guildId}:${userId}`) ?? null
  }

  async activeRecords(guildId: string, now: Date): Promise<StoredInviteRecord[]> {
    return [...this.invites.values()]
      .filter((i) => i.guildId === guildId && i.record !== null && i.keyId !== null && isInviteActive(i, now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((i) => {
        const newest = new Map<string, { groupId: Uint8Array; epoch: number }>()
        for (const b of this.bundles) {
          if (b.inviteId !== i.id) continue
          const k = Buffer.from(b.groupId).toString('hex')
          const seen = newest.get(k)
          if (!seen || b.epoch > seen.epoch) newest.set(k, { groupId: b.groupId, epoch: b.epoch })
        }
        return {
          inviteId: i.id,
          keyId: i.keyId!,
          record: i.record!,
          expiresAt: i.expiresAt,
          bundled: [...newest.values()].sort((a, b) => compareBytes(a.groupId, b.groupId)),
        }
      })
  }

  async insertBundle(b: NewInviteBundle): Promise<void> {
    if (!this.invites.has(b.inviteId)) throw new Error('unknown invite')
    this.bundles.push({ ...b, id: randomUUID(), createdAt: new Date() })
  }

  async trimBundles(inviteId: string, maxBytes: number, senderUser?: string): Promise<number> {
    const mine = this.bundles.filter((b) => b.inviteId === inviteId && (senderUser === undefined || b.senderUser === senderUser))
    let total = mine.reduce((n, b) => n + b.size, 0)
    const drop = new Set<string>()
    for (const b of mine) {
      if (total <= maxBytes) break
      drop.add(b.id)
      total -= b.size
    }
    this.bundles = this.bundles.filter((b) => !drop.has(b.id))
    return drop.size
  }

  async listBundles(inviteId: string): Promise<InviteBundleRow[]> {
    return this.bundles.filter((b) => b.inviteId === inviteId)
  }

  async revokeInvites(ids: readonly string[]): Promise<{ inviteId: string; code: string }[]> {
    const out: { inviteId: string; code: string }[] = []
    for (const id of ids) {
      const row = this.invites.get(id)
      if (!row || row.revoked) continue
      row.revoked = true
      out.push({ inviteId: row.id, code: row.code })
    }
    this.bundles = this.bundles.filter((b) => !ids.includes(b.inviteId))
    return out
  }

  async deleteStaleBundles(before: Date): Promise<number> {
    const stale = (i: InviteRow | undefined) =>
      !i || i.revoked || (i.expiresAt !== null && i.expiresAt < before) || (i.exhaustedAt !== null && i.exhaustedAt < before)
    const n = this.bundles.length
    this.bundles = this.bundles.filter((b) => !stale(this.invites.get(b.inviteId)))
    return n - this.bundles.length
  }
}
