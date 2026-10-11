import { useEffect, useLayoutEffect, useRef } from 'react'
import { AtSign, AudioLines, Crown, FileText, Volume2 } from 'lucide-react'
import type { TriggerChar } from '@/lib/mention-complete'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { UserAvatar } from '@/components/shell/user-avatar'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { useMemberView, usePresence } from '@/hooks/use-member'
import { useKeyboardInset } from '@/hooks/use-visual-viewport'
import { ChannelIcon } from '@/lib/channel-icon'
import { hexColor, memberRoles } from '@/lib/model'
import { roleInk } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { pageTitle } from '@/services/docs/page-tree'
import { useGuildStore } from '@/stores/guildStore'
import { CustomEmojiImage } from './emoji'
import type { MentionItem } from './mention-items'
import { memberDetail, popoverMaxHeight, type MemberDetail } from './mobile-mention-model'

/**
 * The suggestion list above the desktop composer. The textarea keeps the focus: the composer
 * moves `active` with the arrow keys and picks with Enter or Tab. A click picks too.
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
          <CustomEmojiImage emoji={item.pick.emoji} className="size-5 shrink-0" />
          <span className="text-text-primary truncate font-semibold">:{item.pick.emoji.name}:</span>
        </>
      )
  }
}

/**
 * The suggestion list of the mobile composer (M6): a square panel across the chat card, 8 px in
 * from each side and 6 px above the composer, never taller than the room above the composer. A
 * head names the scope ("Members · Night Owls") and the trigger character. Rows are 46 high.
 *
 * The field keeps the focus: `pointerdown` and `mousedown` prevent the default, and the `click`
 * picks. The composer closes the list only 150 ms after a blur (`MENU_BLUR_MS`), so a tap that
 * blurred the field still lands on its row.
 */
export function MobileMentionMenu({
  items,
  active,
  scope,
  char,
  guildId,
  onPick,
  onHover
}: {
  items: readonly MentionItem[]
  active: number
  /** The head line: what the list holds and where from (`mentionScope`). */
  scope: string
  char: TriggerChar
  guildId: string | null
  onPick: (item: MentionItem) => void
  onHover: (index: number) => void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const inset = useKeyboardInset()
  const ownerId = useGuildStore((s) => (guildId ? s.guilds.get(guildId)?.ownerId : undefined))
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  // The room above the composer changes with the keyboard and with the rows (reply, uploads)
  // that the composer stacks above its field.
  useLayoutEffect(() => {
    const el = root.current
    const anchor = el?.parentElement
    if (!el || !anchor) return
    const scroller = anchor
      .closest('[data-slot=chat-footer]')
      ?.parentElement?.querySelector('[data-slot="chat-scroll"]')
    const limit = scroller?.getBoundingClientRect().top ?? 0
    el.style.maxHeight = `${popoverMaxHeight(anchor.getBoundingClientRect().top, limit)}px`
  }, [inset, items.length])

  return (
    <div
      ref={root}
      className="bg-surface-raised absolute inset-x-2 bottom-[calc(100%+6px)] z-30 flex flex-col gap-0.5 border border-(--line-sheet) p-1.5 shadow-(--shadow-sheet)"
    >
      <div className="flex h-[26px] shrink-0 items-center gap-1.5 px-2.5" aria-hidden>
        <span className="text-text-tertiary min-w-0 flex-1 truncate text-[11px] leading-[13px] font-extrabold tracking-[0.8px] uppercase">
          {scope}
        </span>
        <span className="text-feature-event-text text-[12px] leading-[14px] font-extrabold">
          {char}
        </span>
      </div>
      <ul
        ref={list}
        id="mention-menu"
        role="listbox"
        aria-label={scope}
        className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain [&_[data-slot=avatar-fallback]]:bg-surface-hover"
      >
        {items.map((item, i) => (
          <li
            key={`${item.kind}:${item.id}`}
            id={`mention-${i}`}
            role="option"
            aria-selected={i === active}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(item)}
            onMouseMove={() => i !== active && onHover(i)}
            className={cn(
              'rounded-control flex h-[46px] shrink-0 cursor-pointer items-center gap-3 px-2.5 select-none',
              i === active ? 'bg-surface-selected' : 'active:bg-surface-hover'
            )}
          >
            {item.kind === 'user' ? (
              <MobileUserRow item={item} guildId={guildId} owner={item.id === ownerId} />
            ) : (
              <MobileItemRow item={item} />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

const DETAIL_TONE: Record<MemberDetail['tone'], string> = {
  voice: 'text-feature-voice-text font-bold',
  quiet: 'text-text-tertiary font-medium',
  danger: 'text-feature-danger-text font-bold'
}

/** A member: avatar 32, the name in role ink, the owner's crown, the activity line, the top role. */
function MobileUserRow({
  item,
  guildId,
  owner
}: {
  item: Extract<MentionItem, { kind: 'user' }>
  guildId: string | null
  owner: boolean
}): React.JSX.Element {
  const userId = item.user.id
  const { member, ink } = useMemberView(guildId, userId, item.user)
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  const status = usePresence(userId)
  const activity = useVoiceActivity(userId, guildId)
  const custom = useCustomStatus(userId)
  const detail = memberDetail(activity, status, custom?.text)
  const role = memberRoles(member, roles)[0]?.name
  const Icon = detail?.icon === 'speaking' ? AudioLines : Volume2
  return (
    <>
      <UserAvatar
        name={item.user.username}
        avatar={item.user.avatar}
        color={ink}
        size={32}
        cutout="bg-surface-raised"
      />
      <MobileRowText
        name={item.nick ?? item.user.username}
        ink={ink}
        aside={item.nick ? item.user.username : undefined}
        badge={
          owner ? (
            <Crown
              className="text-feature-event-text size-[13px] shrink-0"
              aria-label="Guild owner"
            />
          ) : undefined
        }
        detail={
          detail && (
            <span className={cn('flex min-w-0 items-center gap-1', DETAIL_TONE[detail.tone])}>
              {detail.icon && <Icon className="size-3 shrink-0" aria-hidden />}
              <span className="truncate">{detail.text}</span>
            </span>
          )
        }
      />
      {role && (
        <span className="text-text-tertiary max-w-[30%] shrink-0 truncate text-[12px] leading-[14px] font-bold">
          {role}
        </span>
      )}
    </>
  )
}

const TILE = 'flex size-8 shrink-0 items-center justify-center rounded-full'

/** A role, @everyone, a channel, a page or an emoji, in the row form of a member. */
function MobileItemRow({
  item
}: {
  item: Exclude<MentionItem, { kind: 'user' }>
}): React.JSX.Element {
  switch (item.kind) {
    case 'role': {
      const color = item.role.color ? hexColor(item.role.color) : undefined
      const ink = roleInk(color)
      return (
        <>
          <span
            className={cn(TILE, !color && 'bg-fill-control text-text-secondary')}
            style={
              color && ink
                ? { background: `color-mix(in oklab, ${color} 15%, transparent)`, color: ink }
                : undefined
            }
            aria-hidden
          >
            <AtSign className="size-[17px]" />
          </span>
          <MobileRowText
            name={`@${item.role.name}`}
            ink={ink}
            detail={<span className="text-text-tertiary">Notify everyone with this role</span>}
          />
        </>
      )
    }
    case 'everyone':
      return (
        <>
          <span className={cn(TILE, 'bg-feature-event/15 text-feature-event-text')} aria-hidden>
            <AtSign className="size-[17px]" />
          </span>
          <MobileRowText
            name="@everyone"
            ink="var(--feature-event-text)"
            detail={<span className="text-text-tertiary">Notify everyone in the guild</span>}
          />
        </>
      )
    case 'channel':
      return (
        <>
          <span className={cn(TILE, 'bg-fill-control text-text-secondary')} aria-hidden>
            <ChannelIcon type={item.channel.type} className="size-[17px]" />
          </span>
          <MobileRowText
            name={item.channel.name ?? ''}
            detail={
              item.channel.topic ? (
                <span className="text-text-tertiary">{item.channel.topic}</span>
              ) : undefined
            }
          />
        </>
      )
    case 'page':
      return (
        <>
          <span className={cn(TILE, 'bg-feature-page/15 text-feature-page-text')} aria-hidden>
            <FileText className="size-[17px]" />
          </span>
          <MobileRowText
            name={pageTitle(item.page)}
            detail={<span className="text-text-tertiary">Page in #{item.channelName}</span>}
          />
        </>
      )
    case 'emoji':
      return (
        <>
          <span className={cn(TILE, 'text-[22px] leading-none')} aria-hidden>
            {item.id}
          </span>
          <MobileRowText name={`:${item.code}:`} />
        </>
      )
    case 'custom-emoji':
      return (
        <>
          <span className={TILE} aria-hidden>
            <CustomEmojiImage emoji={item.pick.emoji} className="size-6" />
          </span>
          <MobileRowText name={`:${item.pick.emoji.name}:`} />
        </>
      )
  }
}

/** The name line (15/700, in role ink when given) over an optional detail line (12). */
function MobileRowText({
  name,
  ink,
  aside,
  badge,
  detail
}: {
  name: string
  ink?: string
  /** A second name after the first, in tertiary: the username beside a nickname. */
  aside?: string
  badge?: React.ReactNode
  detail?: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="flex min-w-0 items-center gap-[5px]">
        <span
          className="text-text-primary truncate text-[15px] leading-[18px] font-bold"
          style={ink ? { color: ink } : undefined}
        >
          {name}
        </span>
        {badge}
        {aside && (
          <span className="text-text-tertiary truncate text-[12.5px] leading-[18px] font-medium">
            {aside}
          </span>
        )}
      </span>
      {detail && (
        <span className="flex min-w-0 truncate text-[12px] leading-[14px] font-medium">
          {detail}
        </span>
      )}
    </span>
  )
}
