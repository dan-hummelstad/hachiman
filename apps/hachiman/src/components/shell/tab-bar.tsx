import { AudioLines, FileText, Hash, Pin, PinOff, Plus, Search, Volume2, X } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { openSwitcher } from '@/components/shell/switcher-state'
import { DRAG_REGION } from '@/components/shell/sidebar'
import { SidebarControls } from '@/components/shell/sidebar-controls'
import { useSidebarHidden } from '@/components/shell/sidebar-state'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { FEATURE_TEXT } from '@/components/ui/feature'
import { IconButton } from '@/components/ui/icon-button'
import { dmName, guildInitials } from '@/lib/model'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { navigate, useCurrentView, type View } from '@/stores/navStore'
import {
  moveTab,
  pinTab,
  targetOf,
  unpinTab,
  useActiveTabIndex,
  useIsPinned,
  useTabs,
  viewOfTarget,
  type TabTarget
} from '@/stores/tabsStore'
import { useChannelUnread } from '@/stores/unreadStore'
import { useVoiceStore } from '@/stores/voiceStore'

const NO_DRAG = '[-webkit-app-region:no-drag]'

const tabKey = (t: TabTarget): string => `${t.kind}:${t.id}:${t.pageId ?? ''}`

/**
 * The tab row (N1, 48 high, the window drag region): with a hidden sidebar the sidebar controls
 * first (N3), then the pin glyph, the pinned tabs, "+", and with a hidden sidebar the search
 * button and the inbox spot at the end.
 */
export function TabBar({ inbox }: { inbox?: React.ReactNode }): React.JSX.Element {
  const hidden = useSidebarHidden()
  const { insetTitleBar } = usePlatform()
  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center gap-1 pr-2',
        hidden ? (insetTitleBar ? 'pl-[78px]' : 'pl-2') : 'pl-0',
        DRAG_REGION
      )}
    >
      {hidden && <SidebarControls />}
      <PinCurrent />
      <Tabs />
      <Button
        variant="ghost"
        aria-label="Pin a tab"
        title="Pin a tab"
        onClick={() => openSwitcher('pin')}
        className={cn(
          'border-accent-primary/50 bg-accent-tint text-accent-text hover:bg-accent-tint hover:border-accent-primary rounded-control size-[34px] shrink-0 border p-0 has-[>svg]:p-0',
          NO_DRAG
        )}
      >
        <Plus className="size-4" />
      </Button>
      {hidden && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
          <IconButton
            label="Search or jump to"
            tooltipSide="bottom"
            onClick={() => openSwitcher('open')}
            className="text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded-control"
          >
            <Search className="size-4" />
          </IconButton>
          {inbox}
        </div>
      )}
    </div>
  )
}

/** The pin glyph at the start of the bar: pins or unpins the open view. */
function PinCurrent(): React.JSX.Element {
  const view = useCurrentView()
  const target = targetOf(view)
  const pinned = useIsPinned(target)
  const label =
    target === null ? 'This view cannot be pinned' : pinned ? 'Unpin tab' : 'Pin to tabs'
  return (
    <IconButton
      label={label}
      tooltipSide="bottom"
      pressed={pinned}
      disabled={target === null}
      onClick={() => target && (pinned ? unpinTab(target) : pinTab(target))}
      className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded-control size-7"
    >
      {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
    </IconButton>
  )
}

function Tabs(): React.JSX.Element {
  const tabs = useTabs()
  const active = useActiveTabIndex()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const ids = tabs.map(tabKey)
  const onDragEnd = ({ active: a, over }: DragEndEvent): void => {
    if (!over || a.id === over.id) return
    const from = ids.indexOf(String(a.id))
    const to = ids.indexOf(String(over.id))
    if (from >= 0 && to >= 0) moveTab(from, to)
  }
  return (
    <div
      role="tablist"
      aria-label="Pinned tabs"
      className={cn(
        'flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        NO_DRAG
      )}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          {tabs.map((t, i) => (
            <Tab key={ids[i]} id={ids[i]} target={t} index={i} active={i === active} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  )
}

/** One pinned tab: crest, type icon, name, one state mark; the lit one has ✕ to unpin. */
function Tab({
  id,
  target,
  index,
  active
}: {
  id: string
  target: TabTarget
  index: number
  active: boolean
}): React.JSX.Element | null {
  const channel = useChannelStore((s) => s.channels.get(target.id))
  const guild = useGuildStore((s) => (target.guildId ? s.guilds.get(target.guildId) : undefined))
  const pageTitle = useDocsStore((s) =>
    target.pageId
      ? s.pagesByChannel.get(target.id)?.find((p) => p.id === target.pageId)?.title
      : undefined
  )
  const badge = useChannelUnread(target.id)
  const inCall = useVoiceStore((s) => s.channelId !== null && s.channelId === target.id)
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id
  })
  // A target that is gone: pruneTabs drops it once the caches show that.
  if (!channel) return null

  const name =
    target.kind === 'dm'
      ? dmName(channel)
      : target.kind === 'page'
        ? pageTitle || 'Untitled'
        : (channel.name ?? '')
  const other = target.kind === 'dm' ? channel.recipients?.[0] : undefined
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined
  }
  const shortcut = index < 9 ? ` (${index + 1})` : ''

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={`${name}${shortcut}`}
      onClick={() => navigate(viewOfTarget(target))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(viewOfTarget(target))
        }
      }}
      className={cn(
        'rounded-control group/tab flex h-[34px] max-w-[200px] min-w-[52px] shrink cursor-default items-center gap-1.5 px-2 text-[13px] select-none',
        'focus-visible:ring-ring outline-none focus-visible:ring-2',
        active
          ? 'bg-surface-raised text-text-primary font-bold shadow-soft'
          : 'bg-surface-panel/40 text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        isDragging && 'opacity-70'
      )}
    >
      {target.kind === 'dm' ? (
        <UserAvatar name={name} avatar={other?.avatar} size={16} className="shrink-0" />
      ) : (
        <Crest name={guild?.name ?? ''} icon={guild?.icon ?? null} />
      )}
      <TabIcon target={target} type={channel.type} />
      <span className="min-w-0 truncate">{name}</span>
      {inCall ? (
        <AudioLines aria-label="In call" className="text-feature-voice size-3.5 shrink-0" />
      ) : badge.mentions > 0 ? (
        <span className="bg-mention rounded-pill flex h-4 min-w-4 shrink-0 items-center justify-center px-1 text-[10px] font-bold text-white">
          {badge.mentions}
        </span>
      ) : (
        badge.unread && (
          <span aria-label="Unread" className="bg-text-primary size-1.5 shrink-0 rounded-full" />
        )
      )}
      {active && (
        <button
          type="button"
          aria-label={`Unpin ${name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            unpinTab(target)
          }}
          className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover -mr-1 flex size-5 shrink-0 items-center justify-center rounded-[5px]"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

/** The guild crest: the guild icon at 16px, or its initials. */
function Crest({ name, icon }: { name: string; icon: string | null }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="bg-rail text-text-primary flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px] text-[7px] leading-none font-bold"
    >
      {icon ? (
        <img src={hachiman.rest.fileUrl(icon)} alt="" className="size-full object-cover" />
      ) : (
        guildInitials(name).slice(0, 2)
      )}
    </span>
  )
}

/** The type icon in its feature colour; DMs show only the avatar. */
function TabIcon({ target, type }: { target: TabTarget; type: string }): React.JSX.Element | null {
  if (target.kind === 'dm') return null
  if (target.kind === 'page' || type === 'pages')
    return <FileText className={cn('size-3.5 shrink-0', FEATURE_TEXT.page)} />
  if (type === 'voice') return <Volume2 className={cn('size-3.5 shrink-0', FEATURE_TEXT.voice)} />
  return <Hash className="text-text-tertiary size-3.5 shrink-0" />
}

/**
 * "Pin to tabs" for a view (the channel intro, the page header): pins it, or unpins it when it is
 * pinned. Renders nothing for a view that cannot be pinned.
 */
export function PinToTabsButton({
  view,
  className
}: {
  view: View
  className?: string
}): React.JSX.Element | null {
  const target = targetOf(view)
  const pinned = useIsPinned(target)
  if (!target) return null
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => (pinned ? unpinTab(target) : pinTab(target))}
      className={className}
    >
      {pinned ? <PinOff /> : <Pin />}
      {pinned ? 'Unpin tab' : 'Pin to tabs'}
    </Button>
  )
}

/** "Pin to tabs" (or "Unpin tab") for a channel or DM context menu. */
export function PinToTabsMenuItem({ view }: { view: View }): React.JSX.Element | null {
  const target = targetOf(view)
  const pinned = useIsPinned(target)
  if (!target) return null
  return (
    <ContextMenuItem onSelect={() => (pinned ? unpinTab(target) : pinTab(target))}>
      {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin tab' : 'Pin to tabs'}
    </ContextMenuItem>
  )
}
