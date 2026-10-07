import { useState } from 'react'
import { FileText, Users } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { PagesPanel } from '@/components/docs/pages-panel'
import { MemberList } from '@/components/member-list'
import { DmProfileColumn } from '@/components/people/dm-profile-column'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/stores/docsStore'

export type RightColumnTab = 'members' | 'pages'

/**
 * The right column of the content card (arc plan §5 Phase 4).
 * - Guild channel: the "Members | Pages" head over the member list (252 wide). In a pages channel
 *   the Pages tab is the default and the column widens to 540 for the open page (C1).
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

function GuildColumn({
  channel,
  guildId
}: {
  channel: Channel
  guildId: string
}): React.JSX.Element {
  const isPages = channel.type === 'pages'
  const [tab, setTab] = useState<RightColumnTab>(isPages ? 'pages' : 'members')
  const pageCount = useDocsStore((s) =>
    isPages ? s.pagesByChannel.get(channel.id)?.length : undefined
  )
  const options: SegmentedOption<RightColumnTab>[] = [
    { value: 'members', label: 'Members', icon: <Users /> },
    { value: 'pages', label: 'Pages', icon: <FileText />, count: pageCount }
  ]
  const switcher = (
    <SegmentedControl label="Right column" options={options} value={tab} onChange={setTab} />
  )
  const showPages = isPages && tab === 'pages'

  return (
    <aside
      aria-label={showPages ? 'Pages' : 'Members'}
      className={cn(
        'bg-surface-panel border-line-hairline flex h-full min-h-0 shrink-0 flex-col border-l',
        showPages ? 'w-[540px]' : 'w-[252px]'
      )}
    >
      {showPages ? (
        <PagesPanel channel={channel} switcher={switcher} />
      ) : (
        <>
          <div className="border-line-hairline flex h-14 shrink-0 items-center border-b px-2">
            {isPages ? (
              switcher
            ) : (
              <h2 className="text-text-secondary flex items-center gap-1.5 px-2 text-[13px] font-semibold">
                <Users className="size-4" aria-hidden />
                Members
              </h2>
            )}
          </div>
          <MemberList guildId={guildId} />
        </>
      )}
    </aside>
  )
}
