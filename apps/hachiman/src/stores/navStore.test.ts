import { beforeEach, describe, expect, it } from 'vitest'
import { useDocsStore } from '@/stores/docsStore'
import {
  back,
  clearHistory,
  closeSettings,
  currentView,
  DM_HOME,
  forward,
  HISTORY_CAP,
  navigate,
  openChannel,
  openSettings,
  forgetGuild,
  pushHistory,
  selectGuild,
  setSettingsSection,
  sameView,
  startNavHistory,
  stepHistory,
  useNavStore,
  type View
} from '@/stores/navStore'

const ch = (channelId: string, guildId = 'g1'): View => ({ kind: 'channel', guildId, channelId })

beforeEach(() => {
  startNavHistory()
  useNavStore.setState({ guildKey: DM_HOME, channelByGuild: {}, settings: null })
  useDocsStore.setState({ openPageByChannel: new Map() })
  clearHistory()
})

describe('history reducers', () => {
  it('push adds the view left, clears future and caps at 50', () => {
    let past: View[] = []
    for (let i = 0; i < HISTORY_CAP + 10; i++) past = pushHistory(past, ch(`c${i}`)).past
    expect(past).toHaveLength(HISTORY_CAP)
    expect(past[0]).toEqual(ch('c10'))
    expect(pushHistory([ch('a')], ch('a')).past).toEqual([ch('a')])
  })

  it('back skips a gone target and drops it', () => {
    const h = { past: [ch('a'), ch('gone')], future: [] }
    const r = stepHistory(
      h,
      ch('now'),
      'back',
      (v) => !('channelId' in v && v.channelId === 'gone')
    )
    expect(r).toEqual({ view: ch('a'), past: [], future: [ch('now')] })
  })

  it('returns null with nothing to go to', () => {
    expect(stepHistory({ past: [], future: [] }, ch('a'), 'forward', () => true)).toBeNull()
  })
})

describe('navStore history', () => {
  it('every navigation entry point pushes; back and forward walk it', () => {
    openChannel('g1', 'a')
    openChannel('g1', 'b')
    openChannel(DM_HOME, 'dm1')
    expect(currentView()).toEqual({ kind: 'dm', channelId: 'dm1' })
    expect(useNavStore.getState().past).toEqual([{ kind: 'dmHome' }, ch('a'), ch('b')])

    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('b'))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('a'))
    expect(useNavStore.getState().future).toEqual([{ kind: 'dm', channelId: 'dm1' }, ch('b')])

    expect(forward()).toBe(true)
    expect(currentView()).toEqual(ch('b'))
    // A new navigation clears the forward history.
    openChannel('g2', 'x')
    expect(useNavStore.getState().future).toEqual([])
  })

  it('a page view and a settings view are views', () => {
    openChannel('g1', 'pages')
    useDocsStore.getState().setOpenPage('pages', 'p1')
    const page: View = { kind: 'page', guildId: 'g1', channelId: 'pages', pageId: 'p1' }
    expect(currentView()).toEqual(page)
    openSettings({ kind: 'guild', guildId: 'g1' }, 'roles')
    expect(back()).toBe(true)
    expect(currentView()).toEqual(page)
    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('pages'))
  })

  it('navigate is one history entry', () => {
    openChannel('g1', 'a')
    navigate({ kind: 'dmHome' })
    expect(useNavStore.getState().past).toEqual([{ kind: 'dmHome' }, ch('a')])
    expect(currentView()).toEqual({ kind: 'dmHome' })
  })

  it('back skips targets that no longer exist', () => {
    openChannel('g1', 'a')
    openChannel('g1', 'gone')
    openChannel('g1', 'c')
    expect(back((v) => !(v.kind === 'channel' && v.channelId === 'gone'))).toBe(true)
    expect(currentView()).toEqual(ch('a'))
  })
})

describe('settings view', () => {
  const guildSettings = (section: string | null): View => ({
    kind: 'settings',
    settings: { target: { kind: 'guild', guildId: 'g1' }, section }
  })

  it('opens in front of the channel and closes back to it', () => {
    openChannel('g1', 'a')
    openSettings({ kind: 'channel', channelId: 'a' }, 'permissions')
    expect(currentView()).toEqual({
      kind: 'settings',
      settings: { target: { kind: 'channel', channelId: 'a' }, section: 'permissions' }
    })
    closeSettings()
    expect(useNavStore.getState().settings).toBeNull()
    expect(currentView()).toEqual(ch('a'))
  })

  it('section changes are history entries; back returns to the channel', () => {
    openChannel('g1', 'a')
    openSettings({ kind: 'guild', guildId: 'g1' })
    setSettingsSection('roles')
    expect(currentView()).toEqual(guildSettings('roles'))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(guildSettings(null))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('a'))
    expect(forward()).toBe(true)
    expect(currentView()).toEqual(guildSettings(null))
  })

  it('closing is not an entry: back goes to the view before settings', () => {
    openChannel('g1', 'x')
    openChannel('g1', 'a')
    openSettings({ kind: 'user' }, 'appearance')
    setSettingsSection('devices')
    closeSettings()
    expect(currentView()).toEqual(ch('a'))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('x'))
    expect(useNavStore.getState().settings).toBeNull()
  })

  it('leaving settings for another channel keeps the channel it opened from', () => {
    openChannel('g1', 'a')
    openSettings({ kind: 'user' })
    openChannel('g1', 'b')
    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('a'))
  })

  it('a navigation elsewhere or leaving the guild closes it', () => {
    openChannel('g1', 'a')
    openSettings({ kind: 'user' })
    selectGuild('g2')
    expect(useNavStore.getState().settings).toBeNull()
    openSettings({ kind: 'guild', guildId: 'g2' })
    forgetGuild('g2')
    expect(useNavStore.getState().settings).toBeNull()
    expect(useNavStore.getState().guildKey).toBe(DM_HOME)
  })

  it('a section change without a settings view does nothing', () => {
    setSettingsSection('roles')
    expect(useNavStore.getState().settings).toBeNull()
    setSettingsSection(null)
    expect(useNavStore.getState().settings).toBeNull()
  })

  it('a null section goes back to the list (mobile Back); history back returns to the page', () => {
    const userSettings = (section: string | null): View => ({
      kind: 'settings',
      settings: { target: { kind: 'user' }, section }
    })
    openChannel('g1', 'a')
    openSettings({ kind: 'user' })
    setSettingsSection('appearance')
    setSettingsSection(null)
    expect(currentView()).toEqual(userSettings(null))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(userSettings('appearance'))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(userSettings(null))
  })

  it('Back on the list after a page closes settings; back then skips them', () => {
    openChannel('g1', 'x')
    openChannel('g1', 'a')
    openSettings({ kind: 'channel', channelId: 'a' })
    setSettingsSection('permissions')
    setSettingsSection(null)
    closeSettings()
    expect(currentView()).toEqual(ch('a'))
    expect(back()).toBe(true)
    expect(currentView()).toEqual(ch('x'))
  })

  it('a null section keeps the target', () => {
    openSettings({ kind: 'guild', guildId: 'g1' }, 'roles')
    setSettingsSection(null)
    expect(useNavStore.getState().settings).toEqual({
      target: { kind: 'guild', guildId: 'g1' },
      section: null
    })
  })
})

describe('sameView', () => {
  it('compares by fields, not by key order', () => {
    expect(sameView(ch('a'), { channelId: 'a', guildId: 'g1', kind: 'channel' } as View)).toBe(true)
    expect(sameView(ch('a'), ch('b'))).toBe(false)
    const s1: View = { kind: 'settings', settings: { target: { kind: 'user' }, section: null } }
    const s2: View = { kind: 'settings', settings: { section: null, target: { kind: 'user' } } }
    expect(sameView(s1, s2)).toBe(true)
    expect(sameView(s1, { kind: 'dmHome' })).toBe(false)
  })
})
