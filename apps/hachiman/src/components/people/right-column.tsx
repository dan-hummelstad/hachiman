import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronLeft, FileText, Users } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { PagesPanel } from '@/components/docs/pages-panel'
import { MemberList } from '@/components/member-list'
import { DmProfileColumn } from '@/components/people/dm-profile-column'
import { GuildPagesList } from '@/components/people/guild-pages-list'
import { IconButton } from '@/components/ui/icon-button'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { clampPageColumn, countPageLinks, PAGE_COLUMN_DEFAULT } from '@/lib/right-column'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore } from '@/stores/docsStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { usePrefsStore } from '@/stores/prefsStore'

export type RightColumnTab = 'members' | 'pages'

const EMPTY_MESSAGES: ChatMessage[] = []

/**
 * The right column of the content card (arc plan §5 Phase 4).
 * - Guild channel: the "Members | Pages" head over the member list (252 wide). In a pages channel
 *   the Pages tab is the default and the column widens for the open page (C1, 540 by default; the
 *   user drags its left edge). In a text channel the Pages tab lists the guild's pages, and one
 *   opens beside the chat the same way (N21.1).
 * - DM: the profile of the other user (E2, E3).
 * - Group DM: nothing (null).
 */
export function RightColumn({ channel }: { channel: Channel }): React.JSX.Element | null {
  if (channel.guildId === null) {
    const other = channel.type === 'dm' ? channel.recipients?.[0] : undefined
    return other ? <DmProfileColumn key={channel.id} user={other} /> : null
  }
  return <GuildColumn key={channel.id} channel={channel} guildId={channel.guildId} />
}

/** Pages tab count: the pages channel's page count, or the pages linked in a text channel's loaded messages. */
function usePagesCount(channel: Channel): number | undefined {
  const isPages = channel.type === 'pages'
  const pageCount = useDocsStore((s) =>
    isPages ? s.pagesByChannel.get(channel.id)?.length : undefined
  )
  const messages = useMessageStore((s) =>
    channel.type === 'text' ? (s.byChannel.get(channel.id) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const links = useMemo(() => countPageLinks(messages.map((m) => m.content)), [messages])
  if (isPages) return pageCount
  return links > 0 ? links : undefined
}

function GuildColumn({
  channel,
  guildId
}: {
  channel: Channel
  guildId: string
}): React.JSX.Element {
  const isPages = channel.type === 'pages'
  const hasTabs = isPages || channel.type === 'text'
  const [tab, setTab] = useState<RightColumnTab>(isPages ? 'pages' : 'members')
  /** Text channel: the pages channel whose open page shows beside the chat. */
  const [besideId, setBesideId] = useState<string | null>(null)
  const beside = useChannelStore((s) => (besideId ? s.channels.get(besideId) : undefined))
  const pageCount = usePagesCount(channel)

  const openBeside = useCallback((channelId: string, pageId: string) => {
    useDocsStore.getState().setOpenPage(channelId, pageId)
    setBesideId(channelId)
  }, [])

  const options: SegmentedOption<RightColumnTab>[] = [
    { value: 'members', label: 'Members', icon: <Users /> },
    { value: 'pages', label: 'Pages', icon: <FileText />, count: pageCount }
  ]
  const switcher = (
    <SegmentedControl label="Right column" options={options} value={tab} onChange={setTab} />
  )
  const pagesTab = hasTabs && tab === 'pages'
  const panelChannel = isPages ? channel : beside
  const wide = pagesTab && panelChannel !== undefined
  const pageWidth = usePrefsStore((s) => s.pageColumnWidth)

  return (
    <aside
      aria-label={pagesTab ? 'Pages' : 'Members'}
      style={wide ? { width: clampPageColumn(pageWidth, window.innerWidth) } : undefined}
      className={cn(
        'bg-surface-panel border-line-hairline relative flex h-full min-h-0 shrink-0 flex-col border-l',
        !wide && 'w-[252px]'
      )}
    >
      {wide && <ColumnResizeHandle width={pageWidth} />}
      {wide ? (
        <PagesPanel
          key={panelChannel.id}
          channel={panelChannel}
          onOpenElsewhere={isPages ? undefined : setBesideId}
          switcher={
            isPages ? (
              switcher
            ) : (
              <>
                <IconButton
                  label="All pages"
                  tooltipSide="bottom"
                  onClick={() => setBesideId(null)}
                >
                  <ChevronLeft />
                </IconButton>
                {switcher}
              </>
            )
          }
        />
      ) : (
        <>
          <div className="border-line-hairline flex h-14 shrink-0 items-center border-b px-2">
            {hasTabs ? (
              switcher
            ) : (
              <h2 className="text-text-secondary flex items-center gap-1.5 px-2 text-[13px] font-semibold">
                <Users className="size-4" aria-hidden />
                Members
              </h2>
            )}
          </div>
          {pagesTab ? (
            <GuildPagesList guildId={guildId} onOpen={openBeside} />
          ) : (
            <MemberList guildId={guildId} />
          )}
        </>
      )}
    </aside>
  )
}

const KEY_STEP = 16

/**
 * The left edge of the page column. Dragging it, or the arrow keys while it has focus, set the
 * width (saved in prefsStore); a double-click restores the default.
 */
function ColumnResizeHandle({ width }: { width: number }): React.JSX.Element {
  const setWidth = usePrefsStore((s) => s.setPageColumnWidth)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const set = (w: number): void => setWidth(clampPageColumn(w, window.innerWidth))
  const shown = clampPageColumn(width, window.innerWidth)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the page column"
      aria-valuenow={shown}
      tabIndex={0}
      className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, width: shown }
      }}
      onPointerMove={(e) => {
        if (drag.current) set(drag.current.width + drag.current.x - e.clientX)
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => set(PAGE_COLUMN_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') set(shown + KEY_STEP)
        else if (e.key === 'ArrowRight') set(shown - KEY_STEP)
        else return
        e.preventDefault()
      }}
    >
      <div className="group-hover:bg-accent-primary group-focus-visible:bg-accent-primary mx-auto h-full w-0.5 transition-colors" />
    </div>
  )
}
