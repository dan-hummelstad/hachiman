import { useId, useState } from 'react'
import type { User } from '@hachiman/client'
import { ChevronRight, MessageCircle, Search, SquarePen, Users } from 'lucide-react'
import { SectionLabel } from '@/components/mobile/list'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { ScreenStackProvider, usePushScreen } from '@/components/mobile/pushed-screen'
import { VoiceBar } from '@/components/mobile/voice-bar'
import { ActiveNowStrip } from '@/components/people/active-now'
import { NewMessageDialog } from '@/components/people/new-message-dialog'
import { useOnlinePeople } from '@/components/people/use-people'
import { openSwitcher } from '@/components/shell/switcher-state'
import { AvatarRow, UserAvatar } from '@/components/shell/user-avatar'
import { DmList } from '@/components/sidebar/dm-space'
import { useDmChannels } from '@/hooks/use-hachiman'
import { cn } from '@/lib/utils'

/** The online faces on the People row. */
const MAX_FACES = 4
const FACE = 22

/**
 * The DM home on a phone (M56, ports E1): the header with the counts and New message, the search
 * field, the People row, ACTIVE NOW and every conversation, newest first. The drawer shows the
 * same list (M8). The People row pushes `people`, the People list screen (one level, React
 * state); the DM home is inert under it.
 */
export function MobileDmHome({ people }: { people: React.ReactNode }): React.JSX.Element {
  return (
    <ScreenStackProvider>
      <DmHome people={people} />
    </ScreenStackProvider>
  )
}

function DmHome({ people }: { people: React.ReactNode }): React.JSX.Element {
  const stack = usePushScreen()
  const online = useOnlinePeople()
  const conversations = useDmChannels().length
  const [composing, setComposing] = useState(false)
  const titleId = useId()
  const listId = useId()

  return (
    <section
      aria-labelledby={titleId}
      className="bg-surface-content flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="border-line-hairline flex h-14 shrink-0 items-center gap-2.5 border-b pr-2.5 pl-3.5">
        <span
          aria-hidden
          className="bg-accent-primary text-text-on-accent flex size-8 shrink-0 items-center justify-center rounded-full"
        >
          <MessageCircle className="size-[17px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <h1
            id={titleId}
            className="text-text-primary truncate text-[17px] leading-5 font-extrabold"
          >
            Direct messages
          </h1>
          <p className="text-text-tertiary truncate text-[12.5px] leading-[15px] font-semibold">
            {online.length} online · {conversations}{' '}
            {conversations === 1 ? 'conversation' : 'conversations'}
          </p>
        </div>
        <button
          type="button"
          aria-label="New message"
          onClick={() => setComposing(true)}
          className={cn(
            KIT_ICON_BUTTON,
            'bg-accent-primary text-text-on-accent active:bg-accent-primary/80 [&_svg]:size-[18px]'
          )}
        >
          <SquarePen />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain pt-3 pb-2">
        <div className="px-4">
          <button
            type="button"
            onClick={() => openSwitcher('open')}
            className="rounded-control border-line-strong bg-surface-sunken text-text-tertiary active:bg-surface-hover flex h-10 w-full items-center gap-2.5 border px-3 text-left text-[15px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-line-focus"
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Find or start a conversation</span>
          </button>
        </div>
        <div className="px-4">
          <PeopleRow online={online} onOpen={() => stack.push(people)} />
        </div>
        <ActiveNowStrip />
        <section aria-labelledby={listId} className="flex flex-col gap-2.5">
          <SectionLabel id={listId} className="px-3 pt-1">
            Conversations
          </SectionLabel>
          <DmList variant="home" />
        </section>
      </div>
      <VoiceBar />
      <NewMessageDialog open={composing} onClose={() => setComposing(false)} />
    </section>
  )
}

/** People: who is online (four faces and the count); it pushes the People list. */
function PeopleRow({ online, onOpen }: { online: User[]; onOpen: () => void }): React.JSX.Element {
  const faces = online.slice(0, MAX_FACES)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-control border-surface-hover bg-surface-hover/50 active:bg-surface-hover flex h-[52px] w-full items-center gap-3 border pr-3 pl-3.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-line-focus"
    >
      <Users className="text-text-secondary size-[19px] shrink-0" aria-hidden />
      <span className="text-text-primary min-w-0 flex-1 truncate text-[15.5px] leading-[19px] font-bold">
        People
      </span>
      {faces.length > 0 && (
        <AvatarRow size={FACE} overlap={6}>
          {faces.map((u) => (
            <UserAvatar key={u.id} name={u.username} avatar={u.avatar} size={FACE} />
          ))}
        </AvatarRow>
      )}
      <span className="text-text-tertiary shrink-0 text-[13px] leading-4 font-semibold">
        {online.length} online
      </span>
      <ChevronRight className="text-text-disabled size-[17px] shrink-0" aria-hidden />
    </button>
  )
}
