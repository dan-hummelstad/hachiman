import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { InboxButton } from '@/components/inbox/inbox-button'
import { RightColumn } from '@/components/people/right-column'
import { useSettingsModel } from '@/components/settings/settings-model'
import { SettingsNav } from '@/components/settings/settings-nav'
import { SettingsPage } from '@/components/settings/settings-page'
import { useSettingsMode } from '@/components/settings/use-settings-mode'
import { ChannelPane, NoChannelPane } from '@/components/shell/channel-pane'
import { FavouriteDms } from '@/components/shell/favourite-dms'
import { QuickSwitcher, SwitcherField } from '@/components/shell/quick-switcher'
import { Sidebar } from '@/components/shell/sidebar'
import { SidebarControls } from '@/components/shell/sidebar-controls'
import { useSidebarView } from '@/components/shell/sidebar-state'
import { TabBar } from '@/components/shell/tab-bar'
import { useSidebarReveal } from '@/components/shell/use-sidebar-reveal'
import { SpaceBar } from '@/components/shell/space-bar'
import { DmSpace } from '@/components/sidebar/dm-space'
import { GuildChannelList } from '@/components/sidebar/guild-channels'
import { useGuildTint } from '@/components/shell/use-guild-tint'
import { VoiceDock } from '@/components/voice-connected-panel'
import { VoiceRoom } from '@/components/voice/voice-room'
import { useAppShortcuts } from '@/hooks/use-app-shortcuts'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useMediaQuery } from '@/hooks/use-media-query'
import { isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useVoiceStore } from '@/stores/voiceStore'
import {
  closeSettings,
  selectChannel,
  setSettingsSection,
  useSelectedChannelId,
  useSelectedGuildId
} from '@/stores/navStore'

/** The window wallpaper: tinted by the guild (N4), or the user's custom gradient (useGuildTint). */
const WALLPAPER = cn(
  'bg-surface-window',
  'bg-(image:--wallpaper-light)',
  'dark:bg-(image:--wallpaper-dark)'
)

/**
 * Signed-in layout (docs/ui-redesign.md §6): the window is a wallpaper tinted by the guild (N4).
 * On it sit the sidebar (280) and the content column: the tab row (48, the window drag region)
 * and the content card (inset 8 right and bottom, 1px border). The card holds the pane and the
 * right column (RightColumn: members 252, the page 540 in a pages channel, a DM profile).
 *
 * N3: with the sidebar hidden, the card takes the window width (inset 8), the sidebar slides in
 * over it from the left edge, and the voice dock floats in the card's bottom-left corner. The
 * card then sets `--dock-inset` (the dock width and its gap) and `--dock-height`: the composer
 * footer shifts right by the inset and is at least as tall as the dock, so the transcript ends
 * above the dock and nothing is covered. The one VoiceDock moves between the sidebar foot and the float
 * spot (useDockHost); it does not remount.
 *
 * Settings (Phase 7): the sidebar middle shows the settings list and the card shows the settings
 * page, in place of the channel list, the pane and the right column. Nothing covers the window.
 */
export function Shell(): React.JSX.Element {
  const selectedGuildId = useSelectedGuildId()
  const selectedChannelId = useSelectedChannelId()
  const selectedChannel = useChannelStore((s) =>
    selectedChannelId ? s.channels.get(selectedChannelId) : undefined
  )
  const guildChannels = useGuildChannels(selectedGuildId)
  const tint = useGuildTint(selectedGuildId)
  // The right column defaults open only on wide windows; an explicit toggle overrides the default.
  const wide = useMediaQuery('(min-width: 1200px)')
  const [sidePref, setSidePref] = useState<boolean | null>(null)
  const sideOpen = sidePref ?? wide
  const isPages = selectedChannel?.type === 'pages'
  const toggleSide = selectedChannel ? () => setSidePref(!sideOpen) : undefined
  const sidebar = useSidebarView()
  const hidden = sidebar !== 'docked'
  const tucked = sidebar === 'tucked'
  const inVoice = useVoiceStore((s) => s.channelId !== null)
  const floatDock = tucked && inVoice
  // Kept while the sidebar is revealed: the revealed sidebar slides over, nothing moves.
  const dockInset = hidden && inVoice
  const settings = useSettingsMode()
  const settingsModel = useSettingsModel(settings?.target ?? null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [footSlot, setFootSlot] = useState<HTMLDivElement | null>(null)
  const [floatSlot, setFloatSlot] = useState<HTMLDivElement | null>(null)
  const dockHost = useDockHost(floatDock ? floatSlot : footSlot)
  const dockHeight = useLastHeight(floatSlot)
  useSidebarReveal(sidebarRef)
  useAppShortcuts()

  // Default to the first text channel when a guild has no (valid) selection.
  useEffect(() => {
    if (!selectedGuildId || selectedChannel) return
    const first = guildChannels.find((c) => c.type === 'text')
    if (first) selectChannel(first.id, selectedGuildId)
  }, [selectedGuildId, selectedChannel, guildChannels])

  return (
    <div
      style={tint as React.CSSProperties}
      className={cn('relative flex min-h-0 flex-1 [--dock-width:264px]', WALLPAPER)}
    >
      {tucked && (
        <div
          aria-hidden
          className="from-text-tertiary/35 pointer-events-none absolute inset-y-0 left-0 z-30 w-2 bg-gradient-to-r to-transparent"
        />
      )}
      <div
        ref={sidebarRef}
        inert={tucked}
        className={cn(
          'flex min-h-0',
          hidden &&
            cn(
              'absolute inset-y-0 left-0 z-40 shadow-xl transition-transform duration-150 ease-out',
              WALLPAPER
            ),
          tucked && '-translate-x-full shadow-none'
        )}
      >
        <Sidebar
          controls={
            <>
              <SidebarControls />
              <div className="ml-auto">
                <InboxButton />
              </div>
            </>
          }
          top={
            <>
              <SpaceBar />
              <SwitcherField />
              <FavouriteDms label={settings !== null || selectedGuildId !== null} />
            </>
          }
          middle={
            settings && settingsModel ? (
              <SettingsNav
                model={settingsModel}
                section={settings.section}
                onSelect={setSettingsSection}
                onBack={closeSettings}
              />
            ) : selectedGuildId ? (
              <GuildChannelList guildId={selectedGuildId} />
            ) : (
              <DmSpace />
            )
          }
          foot={<div ref={setFootSlot} className="contents" />}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabBar inbox={<InboxButton />} />
        <div
          className={cn(
            'border-line-hairline bg-surface-content relative mb-2 flex min-h-0 flex-1 border',
            hidden ? 'mx-2' : 'mr-2',
            dockInset && '[--dock-inset:calc(var(--dock-width)+8px)]'
          )}
          style={
            dockInset ? ({ '--dock-height': `${dockHeight}px` } as React.CSSProperties) : undefined
          }
        >
          {settings && settingsModel ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <SettingsPage
                model={settingsModel}
                section={settings.section}
                onClose={closeSettings}
              />
            </div>
          ) : (
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {selectedGuildId === null && !selectedChannel ? (
                <HomePane />
              ) : selectedChannel ? (
                <ChannelPane
                  channel={selectedChannel}
                  side={isPages ? 'pages' : 'members'}
                  sideOpen={sideOpen}
                  onToggleSide={toggleSide}
                >
                  {/* The single gate: voice channels carry no messages (no history, typing, composer). */}
                  {selectedChannel.type === 'voice' && isGuildChannel(selectedChannel) ? (
                    <VoiceRoom key={selectedChannel.id} channel={selectedChannel} />
                  ) : (
                    <ChatBody channel={selectedChannel} />
                  )}
                </ChannelPane>
              ) : (
                <NoChannelPane />
              )}
            </main>
          )}
          {!settings && sideOpen && selectedChannel && <RightColumn channel={selectedChannel} />}
          <div
            ref={setFloatSlot}
            className={cn(
              'bg-surface-window absolute bottom-2 left-2 z-20 w-(--dock-width) shadow-xl',
              !floatDock && 'hidden'
            )}
          />
        </div>
      </div>
      <QuickSwitcher />
      {createPortal(<VoiceDock />, dockHost)}
    </div>
  )
}

/**
 * The last non-zero height of `el`. The float slot is hidden while the sidebar is revealed, but
 * the chat keeps its inset then (nothing moves), so the last floating height stays in use.
 */
function useLastHeight(el: HTMLElement | null): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const h = entry?.borderBoxSize[0]?.blockSize ?? 0
      if (h > 0) setHeight(Math.ceil(h))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return height
}

/** A node the VoiceDock renders into, kept in `slot`: moving it keeps the dock mounted. */
function useDockHost(slot: HTMLElement | null): HTMLElement {
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.style.display = 'contents'
    return el
  })
  useLayoutEffect(() => {
    if (slot && host.parentElement !== slot) slot.appendChild(host)
  }, [slot, host])
  useEffect(() => () => host.remove(), [host])
  return host
}
