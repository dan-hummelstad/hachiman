/**
 * The DocsRepo conformance suite on InMemoryDocsStore (no database).
 */
import { randomBytes, randomUUID } from 'node:crypto'

import { describeDocsRepo } from './repo.conformance'
import { InMemoryDocsStore } from './repo.in-memory'

describeDocsRepo('InMemoryDocsStore', async () => {
  const store = new InMemoryDocsStore()
  return {
    transaction: (fn) => store.transaction(fn),
    fx: {
      addUser: async () => randomUUID(),
      addGuild: async () => store.addGuild(),
      addChannel: async (guildId) => store.addChannel(guildId),
      addGroup: async () => new Uint8Array(randomBytes(16)),
      addUpload: async (u) => store.addUpload(u).id,
      uploadExists: async (id) => store.state.uploads.has(id),
      upload: async (id) => {
        const u = store.state.uploads.get(id)
        return u ? { purpose: u.purpose, pageId: u.pageId, lastReferencedAt: u.lastReferencedAt } : null
      },
      storage: async (guildId) => store.storage(guildId),
    },
  }
})
