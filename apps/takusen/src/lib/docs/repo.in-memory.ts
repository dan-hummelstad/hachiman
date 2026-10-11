/**
 * DocsRepo in memory (repo.ts), for tests without a database. A transaction
 * holds one store-wide lock, so transactions run one at a time, and a throw
 * rolls the state back. The claim rules are the pure forms in lib/uploads.ts.
 */
import { randomUUID } from 'node:crypto'

import type { DocPageRow, DocSnapshotRow, DocUpdateRow, UploadRow } from '@/db/schema'
import { UnknownUploadError } from '@/lib/errors'
import { pageMediaClaimable, pageSnapshotClaimable } from '@/lib/uploads'

import type { DeletedUpload, DocsRepo, StoredSnapshot } from './repo'

export type MemUpload = Pick<UploadRow, 'id' | 'uploaderId' | 'key' | 'size' | 'encrypted' | 'purpose' | 'pageId' | 'lastReferencedAt' | 'createdAt'>

interface State {
  /** channel id → guild id */
  channels: Map<string, string>
  /** guild id → page_storage_bytes */
  guilds: Map<string, number>
  pages: Map<string, DocPageRow>
  updates: DocUpdateRow[]
  snapshots: DocSnapshotRow[]
  uploads: Map<string, MemUpload>
}

export class InMemoryDocsStore {
  state: State = { channels: new Map(), guilds: new Map(), pages: new Map(), updates: [], snapshots: [], uploads: new Map() }
  private tail: Promise<unknown> = Promise.resolve()

  // MARK: - Fixtures

  addGuild(): string {
    const id = randomUUID()
    this.state.guilds.set(id, 0)
    return id
  }

  addChannel(guildId: string): string {
    const id = randomUUID()
    this.state.channels.set(id, guildId)
    return id
  }

  addUpload(u: Partial<MemUpload> & Pick<MemUpload, 'uploaderId'>): MemUpload {
    const id = u.id ?? randomUUID()
    const row: MemUpload = { id, key: `${id}/blob`, size: 100, encrypted: true, purpose: null, pageId: null, lastReferencedAt: null, createdAt: new Date(), ...u }
    this.state.uploads.set(id, row)
    return row
  }

  storage(guildId: string): number {
    return this.state.guilds.get(guildId) ?? 0
  }

  // MARK: - Transactions

  async transaction<T>(fn: (repo: DocsRepo) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const saved = structuredClone(this.state)
      try {
        return await fn(this.repo())
      } catch (err) {
        this.state = saved
        throw err
      }
    })
    this.tail = run.catch(() => {})
    return run
  }

  /** A repo outside a transaction, for reads. */
  repo(): DocsRepo {
    const s = () => this.state
    const subtree = (pageId: string): string[] => {
      if (!s().pages.has(pageId)) return []
      const out = [pageId]
      for (let i = 0; i < out.length; i++) {
        for (const p of s().pages.values()) if (p.parentId === out[i]) out.push(p.id)
      }
      return out
    }
    const guildOfPage = (pageId: string) => {
      const page = s().pages.get(pageId)
      return page ? s().channels.get(page.channelId) : undefined
    }
    const copy = (p: DocPageRow): DocPageRow => ({ ...p, bannerUploadIds: [...p.bannerUploadIds] })
    const stored = (row: DocSnapshotRow): StoredSnapshot => {
      const u = s().uploads.get(row.uploadId)!
      return { row: { ...row }, key: u.key, size: u.size }
    }
    const removeUploads = (ids: Set<string>): DeletedUpload[] => {
      const out: DeletedUpload[] = []
      for (const id of ids) {
        const u = s().uploads.get(id)
        if (!u || u.pageId === null) continue
        const guildId = guildOfPage(u.pageId)
        if (guildId) s().guilds.set(guildId, Math.max(0, (s().guilds.get(guildId) ?? 0) - u.size))
        s().uploads.delete(id)
        out.push({ key: u.key, size: u.size })
      }
      s().snapshots = s().snapshots.filter((r) => s().uploads.has(r.uploadId))
      return out
    }

    return {
      async listPages(channelId) {
        return [...s().pages.values()].filter((p) => p.channelId === channelId).map(copy)
      },
      async getPage(pageId) {
        const p = s().pages.get(pageId)
        return p ? copy(p) : null
      },
      async lockPage(pageId) {
        const p = s().pages.get(pageId)
        return p ? copy(p) : null
      },
      async lockTree() {},
      async insertPage(values) {
        if (s().pages.has(values.id)) return null
        const now = new Date()
        const row: DocPageRow = { ...values, bannerEnvelope: null, bannerUploadIds: [], latestSeq: 0, createdAt: now, updatedAt: now }
        s().pages.set(row.id, row)
        return copy(row)
      },
      async updatePage(pageId, patch) {
        const p = s().pages.get(pageId)
        if (!p) return null
        Object.assign(p, patch, patch.bannerUploadIds && { bannerUploadIds: [...patch.bannerUploadIds] })
        return copy(p)
      },
      async subtreeIds(pageId) {
        return subtree(pageId)
      },
      async deletePage(pageId) {
        const ids = new Set(subtree(pageId))
        for (const id of ids) s().pages.delete(id)
        s().updates = s().updates.filter((u) => !ids.has(u.pageId))
        s().snapshots = s().snapshots.filter((r) => !ids.has(r.pageId))
        for (const u of s().uploads.values()) if (u.pageId && ids.has(u.pageId)) s().uploads.delete(u.id)
      },

      async nextSeq(pageId) {
        const p = s().pages.get(pageId)
        if (!p) return null
        p.latestSeq += 1
        return p.latestSeq
      },
      async insertUpdate(values) {
        if (s().updates.some((u) => u.pageId === values.pageId && u.seq === values.seq)) throw new Error('duplicate (page_id, seq)')
        const row: DocUpdateRow = { ...values, createdAt: new Date() }
        s().updates.push(row)
        return { ...row }
      },
      async listUpdates(pageId, after, limit) {
        return s()
          .updates.filter((u) => u.pageId === pageId && u.seq > after)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((u) => ({ ...u }))
      },
      async deleteUpdatesThrough(pageId, seq) {
        s().updates = s().updates.filter((u) => u.pageId !== pageId || u.seq > seq)
      },

      async listSnapshots(pageId) {
        return s()
          .snapshots.filter((r) => r.pageId === pageId)
          .sort((a, b) => b.baseSeq - a.baseSeq)
          .map(stored)
      },
      async newestSnapshots(channelId) {
        const newest = new Map<string, DocSnapshotRow>()
        for (const r of s().snapshots) {
          if (s().pages.get(r.pageId)?.channelId !== channelId) continue
          const cur = newest.get(r.pageId)
          if (!cur || r.baseSeq > cur.baseSeq) newest.set(r.pageId, r)
        }
        return [...newest.values()].map(stored)
      },
      async insertSnapshot(values) {
        if (s().snapshots.some((r) => (r.pageId === values.pageId && r.baseSeq === values.baseSeq) || r.uploadId === values.uploadId)) {
          throw new Error('duplicate snapshot')
        }
        const row: DocSnapshotRow = { ...values, createdAt: new Date() }
        s().snapshots.push(row)
        return { ...row }
      },
      async rewrapSnapshot(pageId, baseSeq, values) {
        const row = s().snapshots.find((r) => r.pageId === pageId && r.baseSeq === baseSeq)
        if (!row) return null
        Object.assign(row, values)
        return { ...row }
      },

      async claimSnapshotUpload(pageId, uploadId, userId) {
        const u = s().uploads.get(uploadId)
        if (!u || !pageSnapshotClaimable(u, userId)) throw new UnknownUploadError(`Unknown upload ${uploadId}`)
        u.pageId = pageId
        return { key: u.key, size: u.size }
      },
      async claimMediaUploads(pageId, uploadIds, userId, now) {
        let added = 0
        for (const id of uploadIds) {
          const u = s().uploads.get(id)
          if (!u || !pageMediaClaimable(u, userId, pageId)) throw new UnknownUploadError(`Unknown upload ${id}`)
          if (u.purpose === null) added += u.size
          Object.assign(u, { purpose: 'page_media', pageId, lastReferencedAt: now })
        }
        return added
      },
      async touchPageMedia(pageId, uploadIds, now) {
        for (const id of uploadIds) {
          const u = s().uploads.get(id)
          if (u?.purpose === 'page_media' && u.pageId === pageId) u.lastReferencedAt = now
        }
      },
      async deletePageUploads(scope) {
        if ('uploadIds' in scope) return removeUploads(new Set(scope.uploadIds))
        const pages = new Set(scope.pageIds)
        return removeUploads(new Set([...s().uploads.values()].filter((u) => u.pageId && pages.has(u.pageId)).map((u) => u.id)))
      },
      async addPageStorage(guildId, bytes, limit) {
        const cur = s().guilds.get(guildId)
        if (cur === undefined) return false
        if (bytes > 0 && limit > 0 && cur + bytes > limit) return false
        s().guilds.set(guildId, Math.max(0, cur + bytes))
        return true
      },
    }
  }
}
