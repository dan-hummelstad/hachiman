import { useEffect, useRef, useState } from 'react'
import { DmSpace, GuildChannelList } from '@/components/channel-sidebar'
import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { RightColumn } from '@/components/people/right-column'
import { ChannelPane, NoChannelPane } from '@/components/shell/channel-pane'
import { FavouriteDms } from '@/components/shell/favourite-dms'
import { QuickSwitcher, SwitcherField } from '@/components/shell/quick-switcher'
import { useSwitcherShortcut } from '@/components/shell/switcher-state'
import { Sidebar } from '@/components/shell/sidebar'
import { SidebarControls } from '@/components/shell/sidebar-controls'
import { useSidebarHidden, useSidebarRevealed } from '@/components/shell/sidebar-state'
import { TabBar } from '@/components/shell/tab-bar'
import {
  useSidebarReveal,
  useSidebarShortcut,
  useSidebarTucked
} from '@/components/shell/use-sidebar-reveal'
import { SpaceBar } from '@/components/shell/space-bar'
import { useGuildTint } from '@/components/shell/use-guild-tint'
import { VoiceDock } from '@/components/voice-connected-panel'
import { VoiceRoom } from '@/components/voice/voice-room'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useMediaQuery } from '@/hooks/use-media-query'
import { isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { selectChannel, useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'

/** The window wallpaper, tinted by the guild (N4). */
const WALLPAPER = cn(
  'bg-surface-window',
  'bg-[linear-gradient(180deg,var(--tint-light),color-mix(in_oklab,var(--tint-light)_45%,var(--surface-window)))]',
  'dark:bg-[linear-gradient(180deg,var(--tint-dark),color-mix(in_oklab,var(--tint-dark)_45%,var(--surface-window)))]'
)

/**
 * Signed-in layout (docs/ui-redesign.md §6): the window is a wallpaper tinted by the guild (N4).
 * On it sit the sidebar (280) and the content column: the tab row (48, the window drag region)
 * and the content card (inset 8 right and bottom, 1px border). The card holds the pane and the
 * right column (RightColumn: members 252, the page 540 in a pages channel, a DM profile).
 *
 * N3: with the sidebar hidden, the card takes the window width (inset 8), the sidebar slides in
 * over it from the left edge, and the voice dock floats in the card's bottom-left corner. The
 * card then sets `--dock-inset` (the dock width and its gap) and the footers in the pane shift
 * right by it, so the composer is not covered.
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
  const hidden = useSidebarHidden()
  const revealed = useSidebarRevealed()
  const tucked = useSidebarTucked()
  const inVoice = useVoiceStore((s) => s.channelId !== null)
  const floatDock = tucked && inVoice
  // Kept while the sidebar is revealed: the revealed sidebar slides over, nothing moves.
  const dockInset = hidden && inVoice
  const sidebarRef = useRef<HTMLDivElement>(null)
  useSidebarReveal(sidebarRef)
  useSidebarShortcut()
  useSwitcherShortcut()

  // Default to the first text channel when a guild has no (valid) selection.
  useEffect(() => {
    if (!selectedGuildId || selectedChannel) return
    const first = guildChannels.find((c) => c.type === 'text')
    if (first) selectChannel(first.id, selectedGuildId)
  }, [selectedGuildId, selectedChannel, guildChannels])

  return (
    <div
      style={tint as React.CSSProperties}
      className={cn('relative flex min-h-0 flex-1', WALLPAPER)}
    >
      {hidden && !revealed && (
        <div
          aria-hidden
          className="from-line-strong/40 pointer-events-none absolute inset-y-0 left-0 z-30 w-2 bg-gradient-to-r to-transparent"
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
          hidden && !revealed && '-translate-x-full shadow-none'
        )}
      >
        <Sidebar
          controls={
            <>
              <SidebarControls />
              {/* N8: the inbox button goes at the end of this row. */}
            </>
          }
          top={
            <>
              <SwitcherField />
              <FavouriteDms />
            </>
          }
          middle={selectedGuildId ? <GuildChannelList guildId={selectedGuildId} /> : <DmSpace />}
          foot={
            <>
              {!tucked && <VoiceDock />}
              <SpaceBar />
            </>
          }
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabBar />
        <div
          style={dockInset ? ({ '--dock-inset': '272px' } as React.CSSProperties) : undefined}
          className={cn(
            'border-line-hairline bg-surface-content relative mb-2 flex min-h-0 flex-1 border',
            hidden ? 'mx-2' : 'mr-2',
            dockInset && '[&_main_footer]:pl-[calc(var(--dock-inset)+16px)]'
          )}
        >
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
          {sideOpen && selectedChannel && <RightColumn channel={selectedChannel} />}
          {floatDock && (
            <div className="bg-surface-window absolute bottom-2 left-2 z-20 w-[264px] shadow-xl">
              <VoiceDock />
            </div>
          )}
        </div>
      </div>
      <QuickSwitcher />
    </div>
  )
}
