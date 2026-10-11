import type { View } from '@/stores/navStore'

/**
 * The close rule of the mobile drawers (docs/ios-mobile-ui-spec.md §2.4). Pure: the MobileShell
 * feeds it each change of the shown view and each dialog that opens.
 */

/** The left drawer holds the sidebar; the right one the members, pages or a DM profile. */
export type DrawerSide = 'left' | 'right'

/** What can close an open drawer. */
export type DrawerEvent =
  /**
   * The shown view changed (only call it for a real change). `auto`: the app picked it (a
   * guild's first text channel, `lib/auto-select.ts`), not the user.
   */
  | { kind: 'navigate'; from: View; to: View; auto?: boolean }
  /**
   * A dialog or the quick switcher opened. `overLeft`: a control in the left drawer opened it, so
   * the left drawer stays under the dim (M44).
   */
  | { kind: 'dialog'; overLeft?: boolean }

/** The guild of a view: null for the DM space, undefined for settings. */
function guildOf(view: View): string | null | undefined {
  switch (view.kind) {
    case 'dmHome':
    case 'dm':
      return null
    case 'guild':
    case 'channel':
    case 'page':
      return view.guildId
    case 'settings':
      return undefined
  }
}

/**
 * Whether the open left drawer stays open after the shown view went from `from` to `to`. A guild
 * or space switch keeps it, so the new channel list shows: a guild tile lands on the guild's
 * remembered channel (or page), or on the guild, and then the app picks its first text channel
 * (`auto`). A navigation to a channel, thread, DM or page closes it, and so do settings (a pushed
 * screen).
 */
export function keepsLeftDrawer(from: View, to: View, auto = false): boolean {
  switch (to.kind) {
    case 'settings':
    case 'dm':
      return false
    case 'dmHome':
    case 'guild':
      return true
    case 'channel':
    case 'page':
      return guildOf(from) !== to.guildId || auto
  }
}

/** The open drawer after `event`. The right drawer closes on any navigation. */
export function drawerAfter(open: DrawerSide | null, event: DrawerEvent): DrawerSide | null {
  if (open === null) return null
  if (event.kind === 'dialog') return open === 'left' && event.overLeft ? 'left' : null
  return open === 'left' && keepsLeftDrawer(event.from, event.to, event.auto) ? 'left' : null
}
