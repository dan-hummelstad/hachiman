import { describe, expect, it } from 'vitest'
import type { View } from '@/stores/navStore'
import { drawerAfter, keepsLeftDrawer, type DrawerEvent } from './mobile-drawer'

const general: View = { kind: 'channel', guildId: 'g1', channelId: 'c1' }
const random: View = { kind: 'channel', guildId: 'g1', channelId: 'c2' }
const otherGuild: View = { kind: 'channel', guildId: 'g2', channelId: 'c9' }
const guild2: View = { kind: 'guild', guildId: 'g2' }
const guild2General: View = { kind: 'channel', guildId: 'g2', channelId: 'c10' }
const page: View = { kind: 'page', guildId: 'g1', channelId: 'p1', pageId: 'x' }
const dm: View = { kind: 'dm', channelId: 'd1' }
const dmHome: View = { kind: 'dmHome' }
const settings: View = {
  kind: 'settings',
  settings: { target: { kind: 'user' }, section: null }
}

const guild1: View = { kind: 'guild', guildId: 'g1' }
const staleGuild2: View = { kind: 'channel', guildId: 'g2', channelId: 'gone' }

const nav = (from: View, to: View, auto?: boolean): DrawerEvent => ({
  kind: 'navigate',
  from,
  to,
  auto
})

describe('keepsLeftDrawer', () => {
  it('closes on a channel or thread of the same guild', () => {
    expect(keepsLeftDrawer(general, random)).toBe(false)
  })

  it('closes on a DM, a page and settings', () => {
    expect(keepsLeftDrawer(general, dm)).toBe(false)
    expect(keepsLeftDrawer(dmHome, dm)).toBe(false)
    expect(keepsLeftDrawer(general, page)).toBe(false)
    expect(keepsLeftDrawer(general, settings)).toBe(false)
  })

  it('stays open on a guild switch that lands on the remembered channel', () => {
    expect(keepsLeftDrawer(general, otherGuild)).toBe(true)
    expect(keepsLeftDrawer(dm, general)).toBe(true)
  })

  it('stays open on a guild switch with no remembered channel and its default channel', () => {
    expect(keepsLeftDrawer(general, guild2)).toBe(true)
    expect(keepsLeftDrawer(guild2, guild2General, true)).toBe(true)
  })

  it('stays open when the default channel replaces a stale remembered channel', () => {
    expect(keepsLeftDrawer(general, staleGuild2)).toBe(true)
    expect(keepsLeftDrawer(staleGuild2, guild2General, true)).toBe(true)
  })

  it('closes on a tap in a guild with no text channel (the view stayed on the guild)', () => {
    expect(keepsLeftDrawer(guild1, page)).toBe(false)
    expect(keepsLeftDrawer(guild1, general)).toBe(false)
  })

  it('stays open on a switch to the DM space', () => {
    expect(keepsLeftDrawer(general, dmHome)).toBe(true)
    expect(keepsLeftDrawer(dm, dmHome)).toBe(true)
  })
})

describe('drawerAfter', () => {
  it('leaves a closed drawer closed', () => {
    expect(drawerAfter(null, nav(general, otherGuild))).toBeNull()
    expect(drawerAfter(null, { kind: 'dialog' })).toBeNull()
  })

  it('closes either drawer when a dialog opens', () => {
    expect(drawerAfter('left', { kind: 'dialog' })).toBeNull()
    expect(drawerAfter('right', { kind: 'dialog' })).toBeNull()
  })

  it('applies the left rule to the left drawer', () => {
    expect(drawerAfter('left', nav(general, otherGuild))).toBe('left')
    expect(drawerAfter('left', nav(general, random))).toBeNull()
    expect(drawerAfter('left', nav(staleGuild2, guild2General, true))).toBe('left')
    expect(drawerAfter('left', nav(guild1, page))).toBeNull()
  })

  it('closes the right drawer on any navigation', () => {
    expect(drawerAfter('right', nav(general, dm))).toBeNull()
    expect(drawerAfter('right', nav(general, otherGuild))).toBeNull()
    expect(drawerAfter('right', nav(general, page))).toBeNull()
  })
})
