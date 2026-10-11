import type { Channel } from '@hachiman/client'
import { ChatBody } from '@/components/chat/chat-body'
import { HomePane } from '@/components/home-pane'
import { hasRightDrawer, openDrawer } from '@/components/mobile/drawer-state'
import { MobileChannelHeader, type MobileSide } from '@/components/mobile/mobile-channel-header'
import { ChannelPageBar } from '@/components/mobile/page-bar'
import { VoiceBar } from '@/components/mobile/voice-bar'
import { NoChannelPane } from '@/components/shell/channel-pane'
import { DmCallPanel } from '@/components/voice/dm-call'
import { useDmStageShown } from '@/components/voice/dm-stage-state'
import { VoiceRoom } from '@/components/voice/voice-room'
import { isGuildChannel } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'
import { useVoiceStore } from '@/stores/voiceStore'

const showSide = (): void => openDrawer('right')

/** The home-indicator inset on the content colour; it goes while the keyboard is open. */
const SAFE_BOTTOM = 'pb-(--safe-bottom) in-data-[keyboard=open]:pb-0'

const sideOf = (channel: Channel): MobileSide =>
  channel.guildId === null ? 'profile' : channel.type === 'pages' ? 'pages' : 'members'

/**
 * The content of the mobile chat card (docs/ios-mobile-ui-spec.md §2.3): the DM home, a channel
 * or nothing picked. A channel shows the mobile header (M1) over its body: the chat with its
 * mobile footer, which keeps the home-indicator inset itself, or the voice room. The header toggle
 * opens the right drawer. A pages channel opens on its chat, with the page bar (M37) under the
 * header.
 */
export function MobileChatPane(): React.JSX.Element {
  const selectedGuildId = useSelectedGuildId()
  const selectedChannelId = useSelectedChannelId()
  const channel = useChannelStore((s) =>
    selectedChannelId ? s.channels.get(selectedChannelId) : undefined
  )
  // The single gate: voice channels carry no messages (no history, typing, composer).
  const voice = channel?.type === 'voice' && isGuildChannel(channel) ? channel : null
  // My DM call's full-height stage covers the chat (B2).
  const dmStage = useDmStageShown(channel?.guildId === null ? channel.id : null)
  // Outside the call, the voice room shows my voice bar under its join block (M64).
  const inThisCall = useVoiceStore((s) => voice !== null && s.channelId === voice.id)

  return (
    <main
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        !(channel && !voice && !dmStage) && SAFE_BOTTOM
      )}
    >
      {selectedGuildId === null && !channel ? (
        <HomePane />
      ) : channel ? (
        <section
          className={cn('bg-surface-content flex min-h-0 min-w-0 flex-1 flex-col', ROLE_INK_SCOPE)}
        >
          <MobileChannelHeader
            channel={channel}
            side={sideOf(channel)}
            onToggleSide={hasRightDrawer(channel) ? showSide : undefined}
          />
          {channel.type === 'pages' && <ChannelPageBar key={channel.id} channel={channel} />}
          {voice ? (
            <>
              <VoiceRoom key={channel.id} channel={voice} />
              {!inThisCall && <VoiceBar />}
            </>
          ) : (
            <>
              {channel.guildId === null && <DmCallPanel key={channel.id} channel={channel} />}
              {/* Hidden, not unmounted, under the stage: it keeps the draft and the uploads. */}
              <div className={dmStage ? 'hidden' : 'contents'} inert={dmStage}>
                <ChatBody channel={channel} />
              </div>
            </>
          )}
        </section>
      ) : (
        <NoChannelPane />
      )}
    </main>
  )
}
