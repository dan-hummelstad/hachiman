/** The pinned tabs (N1) as a client feature: a tab whose target went away closes. */
import type { GatewayDispatch } from '@hachiman/client'
import { hachiman } from '@/services/client'
import type { ClientFeature } from '@/services/features'
import { useDocsStore } from '@/stores/docsStore'
import { pruneTabs, type TabTarget } from '@/stores/tabsStore'

/** A tab's target is still there: its channel is in the cache, and its page (once loaded). */
function tabExists(t: TabTarget): boolean {
  if (!hachiman.cache.channels.has(t.id)) return false
  if (t.kind !== 'page') return true
  const pages = useDocsStore.getState().pagesByChannel.get(t.id)
  return pages === undefined || pages.some((p) => p.id === t.pageId)
}

let started = false

export const tabsFeature: ClientFeature = {
  name: 'tabs',
  onReady(): void {
    pruneTabs(tabExists)
    if (started) return
    started = true
    // A deleted page closes its tabs.
    useDocsStore.subscribe((s, p) => {
      if (s.pagesByChannel !== p.pagesByChannel) pruneTabs(tabExists)
    })
  },
  onDispatch(e: GatewayDispatch): void {
    if (e.t === 'GUILD_DELETE' || e.t === 'CHANNEL_DELETE') pruneTabs(tabExists)
  }
}
