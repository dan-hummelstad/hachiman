import { beforeEach, describe, expect, it } from 'vitest'
import { useDocsStore } from '@/stores/docsStore'
import {
  back,
  clearHistory,
  currentView,
  DM_HOME,
  forward,
  HISTORY_CAP,
  navigate,
  openChannel,
  openSettings,
  pushHistory,
  stepHistory,
  useNavStore,
  type View
} from '@/stores/navStore'

const ch = (channelId: string, guildId = 'g1'): View => ({ kind: 'channel', guildId, channelId })

beforeEach(() => {
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
