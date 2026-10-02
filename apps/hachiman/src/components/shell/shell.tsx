import { useEffect, useState } from 'react'
import { ChannelSidebar } from '@/components/channel-sidebar'
import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { MemberList } from '@/components/member-list'
import { ServerIconRail } from '@/components/server-icon-rail'
import { ChannelPane, NoChannelPane } from '@/components/shell/channel-pane'
import { VoiceRoom } from '@/components/voice/voice-room'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useMediaQuery } from '@/hooks/use-media-query'
import { isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { selectChannel, useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'

/**
 * Signed-in layout (spec §4): a 4-column grid, rail 72 / channel sidebar 240 / main flex /
 * members 240. Every pane renders its own 48px title bar.
 */
export function Shell(): React.JSX.Element {
  const selectedGuildId = useSelectedGuildId()
  const selectedChannelId = useSelectedChannelId()
  const selectedChannel = useChannelStore((s) =>
    selectedChannelId ? s.channels.get(selectedChannelId) : undefined
  )
  const guildChannels = useGuildChannels(selectedGuildId)
  // Member list defaults open only on wide windows; an explicit toggle overrides the default.
  const wide = useMediaQuery('(min-width: 1200px)')
  const [membersPref, setMembersPref] = useState<boolean | null>(null)
  const membersOpen = membersPref ?? wide
  const showMembers = membersOpen && selectedGuildId !== null
  const toggleMembers = selectedGuildId ? () => setMembersPref(!membersOpen) : undefined

  // Default to the first text channel when a guild has no (valid) selection.
  useEffect(() => {
    if (!selectedGuildId || selectedChannel) return
    const first = guildChannels.find((c) => c.type === 'text')
    if (first) selectChannel(first.id, selectedGuildId)
  }, [selectedGuildId, selectedChannel, guildChannels])

  return (
    <div
      className={cn(
        'grid min-h-0 flex-1',
        showMembers
          ? 'grid-cols-[72px_240px_minmax(0,1fr)_240px]'
          : 'grid-cols-[72px_240px_minmax(0,1fr)]'
      )}
    >
      <ServerIconRail />
      <ChannelSidebar />
      <main className="flex min-h-0 min-w-0 flex-col">
        {selectedGuildId === null && !selectedChannel ? (
          <HomePane />
        ) : selectedChannel ? (
          <ChannelPane
            channel={selectedChannel}
            membersOpen={showMembers}
            onToggleMembers={toggleMembers}
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
        <div className="flex min-h-0 flex-col">
          <MemberList guildId={selectedGuildId} />
        </div>
      )}
    </div>
  )
}
