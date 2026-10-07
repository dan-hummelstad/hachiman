import { useEffect, useState } from 'react'
import { usePanelRef, type Layout } from 'react-resizable-panels'
import type { Channel } from '@hachiman/client'
import { DmSpace, GuildChannelList } from '@/components/channel-sidebar'
import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { PagesPanel } from '@/components/docs/pages-panel'
import { MemberList } from '@/components/member-list'
import { ChannelPane, NoChannelPane } from '@/components/shell/channel-pane'
import { DRAG_REGION, Sidebar } from '@/components/shell/sidebar'
import { SpaceBar } from '@/components/shell/space-bar'
import { useGuildTint } from '@/components/shell/use-guild-tint'
import { VoiceDock } from '@/components/voice-connected-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { VoiceRoom } from '@/components/voice/voice-room'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useMediaQuery } from '@/hooks/use-media-query'
import { isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { selectChannel, useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'
import { usePrefsStore } from '@/stores/prefsStore'

/**
 * Signed-in layout (docs/ui-redesign.md §6): the window is a wallpaper tinted by the guild (N4).
 * On it sit the sidebar (280) and the content column: the tab row (48, the window drag region)
 * and the content card (inset 8 right and bottom, 1px border). The card holds the pane and the
 * right column (members 252). A pages channel puts the pages panel in place of the members
 * column (PagesSplit).
 */
export function Shell(): React.JSX.Element {
  const selectedGuildId = useSelectedGuildId()
  const selectedChannelId = useSelectedChannelId()
  const selectedChannel = useChannelStore((s) =>
    selectedChannelId ? s.channels.get(selectedChannelId) : undefined
  )
  const guildChannels = useGuildChannels(selectedGuildId)
  const tint = useGuildTint(selectedGuildId)
  // Member list defaults open only on wide windows; an explicit toggle overrides the default.
  const wide = useMediaQuery('(min-width: 1200px)')
  const [membersPref, setMembersPref] = useState<boolean | null>(null)
  const membersOpen = membersPref ?? wide
  const isPages = selectedChannel?.type === 'pages'
  const showMembers = membersOpen && selectedGuildId !== null && !isPages
  const toggleMembers = selectedGuildId ? () => setMembersPref(!membersOpen) : undefined

  // Default to the first text channel when a guild has no (valid) selection.
  useEffect(() => {
    if (!selectedGuildId || selectedChannel) return
    const first = guildChannels.find((c) => c.type === 'text')
    if (first) selectChannel(first.id, selectedGuildId)
  }, [selectedGuildId, selectedChannel, guildChannels])

  return (
    <div
      style={tint as React.CSSProperties}
      className={cn(
        'bg-surface-window flex min-h-0 flex-1',
        'bg-[linear-gradient(180deg,var(--tint-light),color-mix(in_oklab,var(--tint-light)_45%,var(--surface-window)))]',
        'dark:bg-[linear-gradient(180deg,var(--tint-dark),color-mix(in_oklab,var(--tint-dark)_45%,var(--surface-window)))]'
      )}
    >
      <Sidebar
        middle={selectedGuildId ? <GuildChannelList guildId={selectedGuildId} /> : <DmSpace />}
        foot={
          <>
            <VoiceDock />
            <SpaceBar />
          </>
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn('h-12 shrink-0', DRAG_REGION)} />
        <div className="border-line-hairline bg-surface-content mr-2 mb-2 flex min-h-0 flex-1 border">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedGuildId === null && !selectedChannel ? (
              <HomePane />
            ) : selectedChannel && isPages ? (
              <PagesSplit key={selectedChannel.id} channel={selectedChannel} />
            ) : selectedChannel ? (
              <ChannelPane
                channel={selectedChannel}
                sideOpen={showMembers}
                onToggleSide={toggleMembers}
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
          {showMembers && (
            <div className="border-line-hairline flex min-h-0 w-[252px] shrink-0 flex-col border-l">
              <MemberList guildId={selectedGuildId} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const MAIN_PANEL = 'main'
const PAGES_PANEL = 'pages'
const DEFAULT_PAGES_SIZE = 50

/**
 * Pages channel: chat on the left, the pages panel on the right. The split is resizable, the
 * panel collapses, and prefsStore keeps its width per channel. The side toggle of the title bar
 * shows and hides the panel.
 */
function PagesSplit({ channel }: { channel: Channel }): React.JSX.Element {
  // Read once: a changed defaultSize would reset the layout.
  const [initialSize] = useState(
    () => usePrefsStore.getState().pagesPanelSize[channel.id] ?? DEFAULT_PAGES_SIZE
  )
  const setPagesPanelSize = usePrefsStore((s) => s.setPagesPanelSize)
  const pagesRef = usePanelRef()
  const [open, setOpen] = useState(initialSize > 0)

  const toggle = (): void => {
    const panel = pagesRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }
  const save = (layout: Layout, meta: { requestedLayout?: Layout | undefined }): void => {
    const size = (meta.requestedLayout ?? layout)[PAGES_PANEL]
    if (size !== undefined) setPagesPanelSize(channel.id, Math.round(size * 10) / 10)
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" onLayoutChanged={save}>
      <ResizablePanel id={MAIN_PANEL} minSize={320} className="flex h-full min-h-0 flex-col">
        <ChannelPane channel={channel} side="pages" sideOpen={open} onToggleSide={toggle}>
          <ChatBody channel={channel} />
        </ChannelPane>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id={PAGES_PANEL}
        panelRef={pagesRef}
        defaultSize={`${initialSize}%`}
        minSize={320}
        collapsible
        onResize={(size) => setOpen(size.inPixels > 0)}
        className="flex h-full min-h-0 flex-col"
      >
        <PagesPanel channel={channel} />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
