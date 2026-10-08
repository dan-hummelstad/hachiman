import { useEffect, useRef } from 'react'
import { AtSign, FileText } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ChannelIcon } from '@/lib/channel-icon'
import { hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'
import { pageTitle } from '@/services/docs/page-tree'
import { CustomEmojiImage } from './emoji'
import type { MentionItem } from './mention-items'

/**
 * The suggestion list above the composer. The textarea keeps the focus: the composer moves
 * `active` with the arrow keys and picks with Enter or Tab. A click picks too.
 */
export function MentionMenu({
  items,
  active,
  onPick,
  onHover
}: {
  items: readonly MentionItem[]
  active: number
  onPick: (item: MentionItem) => void
  onHover: (index: number) => void
}): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <ul
      ref={list}
      id="mention-menu"
      role="listbox"
      aria-label="Suggestions"
      className="bg-surface-raised border-line-strong absolute right-0 bottom-full left-0 z-30 mb-2 max-h-72 overflow-y-auto border p-1 shadow-soft"
    >
      {items.map((item, i) => (
        <li
          key={`${item.kind}:${item.id}`}
          id={`mention-${i}`}
          role="option"
          aria-selected={i === active}
          // mousedown keeps the focus in the textarea.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(item)
          }}
          onMouseMove={() => i !== active && onHover(i)}
          className={cn(
            'rounded-control flex h-9 cursor-pointer items-center gap-2.5 px-2 text-[14px]',
            i === active ? 'bg-surface-selected text-text-primary' : 'text-text-secondary'
          )}
        >
          <ItemRow item={item} />
        </li>
      ))}
    </ul>
  )
}

function ItemRow({ item }: { item: MentionItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <>
          <UserAvatar name={item.user.username} avatar={item.user.avatar} size={22} />
          <span className="text-text-primary truncate font-semibold">
            {item.nick ?? item.user.username}
          </span>
          {item.nick && (
            <span className="text-text-tertiary truncate text-[12.5px]">{item.user.username}</span>
          )}
        </>
      )
    case 'role':
      return (
        <>
          <span
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{
              background: item.role.color ? hexColor(item.role.color) : 'var(--text-tertiary)'
            }}
            aria-hidden
          />
          <span className="text-text-primary truncate font-semibold">@{item.role.name}</span>
          <span className="text-text-tertiary ml-auto text-[12px]">Role</span>
        </>
      )
    case 'everyone':
      return (
        <>
          <AtSign className="text-text-tertiary size-4 shrink-0" aria-hidden />
          <span className="text-text-primary font-semibold">@everyone</span>
          <span className="text-text-tertiary ml-auto text-[12px]">Everyone in the guild</span>
        </>
      )
    case 'channel':
      return (
        <>
          <ChannelIcon
            type={item.channel.type}
            className="text-text-tertiary size-4 shrink-0"
            aria-hidden
          />
          <span className="text-text-primary truncate font-semibold">{item.channel.name}</span>
        </>
      )
    case 'page':
      return (
        <>
          <FileText className="text-feature-page-text size-4 shrink-0" aria-hidden />
          <span className="text-text-primary truncate font-semibold">{pageTitle(item.page)}</span>
          <span className="text-text-tertiary ml-auto truncate text-[12px]">
            Page in #{item.channelName}
          </span>
        </>
      )
    case 'emoji':
      return (
        <>
          <span className="flex size-5 shrink-0 items-center justify-center text-[18px] leading-none">
            {item.id}
          </span>
          <span className="text-text-primary truncate font-semibold">:{item.code}:</span>
        </>
      )
    case 'custom-emoji':
      return (
        <>
          <CustomEmojiImage emoji={item.emoji} className="size-5 shrink-0" />
          <span className="text-text-primary truncate font-semibold">:{item.emoji.name}:</span>
        </>
      )
  }
}
