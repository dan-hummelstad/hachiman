import { beforeEach, describe, expect, it } from 'vitest'
import type { View } from '@/stores/navStore'
import {
  activeIndex,
  isPinned,
  loadTabs,
  moveTab,
  pinTab,
  pruneTabs,
  targetOf,
  unpinTab,
  useTabsStore,
  type TabTarget
} from '@/stores/tabsStore'

const general: TabTarget = { kind: 'channel', id: 'general', guildId: 'g1' }
const lounge: TabTarget = { kind: 'channel', id: 'lounge', guildId: 'g1' }
const dm: TabTarget = { kind: 'dm', id: 'dm1', guildId: null }
const page: TabTarget = { kind: 'page', id: 'wiki', guildId: 'g2', pageId: 'p1' }
const wiki: TabTarget = { kind: 'channel', id: 'wiki', guildId: 'g2' }
const tabs = (): TabTarget[] => useTabsStore.getState().tabs

beforeEach(() => {
  loadTabs(null)
  loadTabs('u1')
})

describe('tabsStore', () => {
  it('pins once, unpins, and reorders', () => {
    pinTab(general)
    pinTab(dm)
    pinTab(general)
    pinTab(page, 0)
    expect(tabs()).toEqual([page, general, dm])
    moveTab(0, 2)
    expect(tabs()).toEqual([general, dm, page])
    unpinTab(dm)
    expect(tabs()).toEqual([general, page])
    expect(isPinned(tabs(), dm)).toBe(false)
    expect(isPinned(tabs(), { ...page })).toBe(true)
  })

  it('cleans up tabs whose target is gone', () => {
    for (const t of [general, lounge, dm, page]) pinTab(t)
    pruneTabs((t) => t.id !== 'lounge' && t.guildId !== 'g2')
    expect(tabs()).toEqual([general, dm])
  })

  it('a sign-out drops the tabs of the account', () => {
    pinTab(general)
    loadTabs(null)
    expect(tabs()).toEqual([])
  })

  it('lights the tab of the open view, for each kind', () => {
    const list = [general, dm, page, wiki]
    const pageView = (pageId: string): View => ({
      kind: 'page',
      guildId: 'g2',
      channelId: 'wiki',
      pageId
    })
    expect(activeIndex(list, { kind: 'channel', guildId: 'g1', channelId: 'general' })).toBe(0)
    expect(activeIndex(list, { kind: 'dm', channelId: 'dm1' })).toBe(1)
    expect(activeIndex(list, pageView('p1'))).toBe(2)
    // Another page of a pinned pages channel lights the channel tab.
    expect(activeIndex(list, pageView('p2'))).toBe(3)
    expect(activeIndex(list, { kind: 'channel', guildId: 'g1', channelId: 'lounge' })).toBe(-1)
    expect(activeIndex(list, { kind: 'dmHome' })).toBe(-1)
    const settings: View = {
      kind: 'settings',
      settings: { scope: { kind: 'user' }, section: null }
    }
    expect(targetOf(settings)).toBeNull()
  })
})
