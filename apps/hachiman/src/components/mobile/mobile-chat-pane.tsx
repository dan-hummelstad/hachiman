import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { hasRightDrawer, openDrawer } from '@/components/mobile/drawer-state'
import { ChannelPane, NoChannelPane } from '@/components/shell/channel-pane'
import { DmCallPanel } from '@/components/voice/dm-call'
import { VoiceRoom } from '@/components/voice/voice-room'
import { isGuildChannel } from '@/lib/model'
import { useChannelStore } from '@/stores/channelStore'
import { useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'

const showSide = (): void => openDrawer('right')

/**
 * The content of the mobile chat card (docs/ios-mobile-ui-spec.md §2.3). For now the panes of the
 * desktop shell: the DM home, a channel (chat, voice room, DM call) or nothing picked. The header
 * toggle opens the right drawer. The home-indicator inset sits under it on the content colour,
 * and goes while the keyboard is open.
 */
export function MobileChatPane(): React.JSX.Element {
  const selectedGuildId = useSelectedGuildId()
  const selectedChannelId = useSelectedChannelId()
  const channel = useChannelStore((s) =>
    selectedChannelId ? s.channels.get(selectedChannelId) : undefined
  )

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-(--safe-bottom) in-data-[keyboard=open]:pb-0">
      {selectedGuildId === null && !channel ? (
        <HomePane />
      ) : channel ? (
        <ChannelPane
          channel={channel}
          side={channel.type === 'pages' ? 'pages' : 'members'}
          sideOpen={false}
          onToggleSide={hasRightDrawer(channel) ? showSide : undefined}
        >
          {/* The single gate: voice channels carry no messages (no history, typing, composer). */}
          {channel.type === 'voice' && isGuildChannel(channel) ? (
            <VoiceRoom key={channel.id} channel={channel} />
          ) : (
            <>
              {channel.guildId === null && <DmCallPanel key={channel.id} channel={channel} />}
              <ChatBody channel={channel} />
            </>
          )}
        </ChannelPane>
      ) : (
        <NoChannelPane />
      )}
    </main>
  )
}
