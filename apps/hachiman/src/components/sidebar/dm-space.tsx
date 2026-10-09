import { MessageCircle, SquarePen, Users } from 'lucide-react'
import type { Channel, VoiceState } from '@hachiman/client'
import { PinToTabsMenuItem } from '@/components/shell/tab-bar'
import { UserAvatar } from '@/components/shell/user-avatar'
import { openDmHome, sidebarRowClass } from '@/components/sidebar/sidebar-row'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { SystemTag } from '@/components/ui/system-tag'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useDmChannels } from '@/hooks/use-hachiman'
import { useOnlineCount } from '@/hooks/use-online-count'
import { dmName } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { selectChannel, useSelectedChannelId } from '@/stores/navStore'
import { useChannelUnread, useDmUnread } from '@/stores/unreadStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * The middle of the sidebar in the DM space (E1–E3): the "Direct messages" header with "New
 * message", the People row with the online count, and the conversations.
 */
export function DmSpace(): React.JSX.Element {
  const selectedChannelId = useSelectedChannelId()
  const online = useOnlineCount(null)
  const dmBadge = useDmUnread()

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 px-1.5">
        <span className="bg-accent-primary text-text-on-accent flex size-[22px] shrink-0 items-center justify-center rounded-full">
          <MessageCircle className="size-3" />
        </span>
        <h2 className="text-label min-w-0 flex-1 truncate font-extrabold">Direct messages</h2>
        <IconButton label="New message" onClick={openDmHome} className="rounded-control">
          <SquarePen />
        </IconButton>
      </div>
      <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <button
          type="button"
          onClick={openDmHome}
          aria-current={selectedChannelId === null ? 'page' : undefined}
          className={sidebarRowClass(selectedChannelId === null)}
        >
          <Users className="text-text-tertiary size-4 shrink-0" />
          <span
            className={cn(
              'flex-1 truncate',
              dmBadge.unread && selectedChannelId !== null && 'text-text-primary font-bold'
            )}
          >
            People
          </span>
          <span className="text-text-tertiary text-xs font-semibold">{online} online</span>
          <UnreadMark badge={dmBadge} dot={false} />
        </button>
        <h3 className="section-label flex h-[30px] items-center px-1 pt-3">Conversations</h3>
        <DmList />
      </div>
    </>
  )
}

/** The DM and group DM rows: avatar, name, the last decrypted message and LIVE. */
export function DmList(): React.JSX.Element {
  const dms = useDmChannels()
  const selectedChannelId = useSelectedChannelId()
  if (dms.length === 0)
    return <p className="text-text-tertiary px-2.5 py-1 text-xs">No conversations yet.</p>
  return (
    <ul className="flex flex-col gap-0.5">
      {dms.map((c) => (
        <DmRow key={c.id} channel={c} selected={selectedChannelId === c.id} />
      ))}
    </ul>
  )
}

function DmRow({ channel, selected }: { channel: Channel; selected: boolean }): React.JSX.Element {
  const isGroup = channel.type === 'group_dm'
  const other = channel.recipients?.[0]
  const name = dmName(channel)
  const status = useGuildStore((s) =>
    other ? (s.presences.get(other.id) ?? 'offline') : undefined
  )
  const preview = useMessageStore((s) => previewOf(s.byChannel.get(channel.id), isGroup))
  const live = useVoiceStore((s) =>
    other && !isGroup ? isStreaming(s.voiceStates, other.id) : false
  )
  const badge = useChannelUnread(channel.id)
  const unread = badge.unread && !selected

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li>
          <button
            type="button"
            onClick={() => selectChannel(channel.id)}
            aria-current={selected ? 'page' : undefined}
            className={sidebarRowClass(selected, 'h-[46px] gap-2.5 pl-1.5 font-normal')}
          >
            <UserAvatar
              name={name}
              avatar={other?.avatar}
              size={32}
              status={isGroup ? undefined : status}
              cutout="bg-surface-window"
            />
            <span className="grid min-w-0 flex-1 leading-tight">
              <span
                className={cn(
                  'text-text-primary truncate text-[14px]',
                  unread ? 'font-extrabold' : 'font-bold'
                )}
              >
                {name}
              </span>
              {preview && (
                <span
                  className={cn(
                    'truncate text-xs',
                    unread ? 'text-text-secondary font-semibold' : 'text-text-tertiary'
                  )}
                >
                  {preview}
                </span>
              )}
            </span>
            {live && <SystemTag kind="live" />}
            <UnreadMark badge={badge} dot={false} />
          </button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PinToTabsMenuItem view={{ kind: 'dm', channelId: channel.id }} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The text of the last decrypted message, with its author in a group. */
function previewOf(messages: ChatMessage[] | undefined, withAuthor: boolean): string | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.decrypt.status !== 'ok') continue
    const text = m.content.trim() || (m.attachments.length > 0 ? 'Sent an attachment' : '')
    if (!text) continue
    return withAuthor ? `${m.author.username}: ${text}` : text
  }
  return null
}

function isStreaming(
  voiceStates: ReadonlyMap<string, ReadonlyMap<string, VoiceState>>,
  userId: string
): boolean {
  for (const states of voiceStates.values()) if (states.get(userId)?.selfStream) return true
  return false
}
