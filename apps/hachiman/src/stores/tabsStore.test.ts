import { beforeEach, describe, expect, it } from 'vitest'
import type { View } from '@/stores/navStore'
import {
  activeIndex,
  currentTabs,
  isPinned,
  migrateLegacyTabs,
  moveTab,
  pinTab,
  pruneTabs,
  targetOf,
  unpinTab,
  type TabTarget
} from '@/stores/tabsStore'
import { usePrefsStore } from '@/stores/prefsStore'

const general: TabTarget = { kind: 'channel', id: 'general', guildId: 'g1' }
const lounge: TabTarget = { kind: 'channel', id: 'lounge', guildId: 'g1' }
const dm: TabTarget = { kind: 'dm', id: 'dm1', guildId: null }
const page: TabTarget = { kind: 'page', id: 'wiki', guildId: 'g2', pageId: 'p1' }
const wiki: TabTarget = { kind: 'channel', id: 'wiki', guildId: 'g2' }
const tabs = (): TabTarget[] => currentTabs()

beforeEach(() => {
  usePrefsStore.setState({ accounts: {}, accountId: 'u1' })
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

  it('a sign-out shows no tabs, and the account gets its own back', () => {
    pinTab(general)
    usePrefsStore.getState().setAccountId(null)
    expect(tabs()).toEqual([])
    pinTab(dm)
    usePrefsStore.getState().setAccountId('u2')
    expect(tabs()).toEqual([])
    usePrefsStore.getState().setAccountId('u1')
    expect(tabs()).toEqual([general])
  })

  it('moves the tabs of the old storage key once, then deletes the key', () => {
    const store = new Map<string, string>([['hachiman:tabs:u1', JSON.stringify([dm, { bad: 1 }])]])
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k)
    }
    const prev = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
    try {
      migrateLegacyTabs('u1')
      expect(tabs()).toEqual([dm])
      expect(store.has('hachiman:tabs:u1')).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true })
    }
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
      settings: { target: { kind: 'user' }, section: null }
    }
    expect(targetOf(settings)).toBeNull()
  })

  it('on the mobile layout, a pages channel chat lights a pinned page tab of the channel', () => {
    const page2: TabTarget = { ...page, pageId: 'p2' }
    const wikiChat: View = { kind: 'channel', guildId: 'g2', channelId: 'wiki' }
    const mobile = { pageTabOfChannel: true }
    expect(activeIndex([general, page, page2], wikiChat, mobile)).toBe(1)
    // The channel's own tab wins.
    expect(activeIndex([page, wiki], wikiChat, mobile)).toBe(1)
    // Desktop does not change, and another channel lights nothing.
    expect(activeIndex([general, page], wikiChat)).toBe(-1)
    const loungeChat: View = { kind: 'channel', guildId: 'g1', channelId: 'lounge' }
    expect(activeIndex([general, page], loungeChat, mobile)).toBe(-1)
  })
})
