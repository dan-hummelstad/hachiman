import { useEffect, useState } from 'react'
import { DmSpace, GuildChannelList } from '@/components/channel-sidebar'
import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { RightColumn } from '@/components/people/right-column'
import { ChannelPane, NoChannelPane } from '@/components/shell/channel-pane'
import { FavouriteDms } from '@/components/shell/favourite-dms'
import { DRAG_REGION, Sidebar } from '@/components/shell/sidebar'
import { SpaceBar } from '@/components/shell/space-bar'
import { useGuildTint } from '@/components/shell/use-guild-tint'
import { VoiceDock } from '@/components/voice-connected-panel'
import { VoiceRoom } from '@/components/voice/voice-room'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useMediaQuery } from '@/hooks/use-media-query'
import { isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { selectChannel, useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'

/**
 * Signed-in layout (docs/ui-redesign.md §6): the window is a wallpaper tinted by the guild (N4).
 * On it sit the sidebar (280) and the content column: the tab row (48, the window drag region)
 * and the content card (inset 8 right and bottom, 1px border). The card holds the pane and the
 * right column (RightColumn: members 252, the page 540 in a pages channel, a DM profile).
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
        top={
          <>
            <FavouriteDms />
          </>
        }
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
        </div>
      </div>
    </div>
  )
}
