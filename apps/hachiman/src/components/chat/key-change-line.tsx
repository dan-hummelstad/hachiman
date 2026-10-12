import { KeyRound } from 'lucide-react'
import { useUserName } from '@/components/security/use-user-name'
import { openDialog } from '@/stores/dialogStore'

/**
 * M59: the security key of the other person of a 1:1 DM changed, and they were never verified,
 * so nothing is paused. A gold card in the transcript (placed by `keyChangeSlot`) with Compare,
 * which opens the safety numbers. It goes when the user verifies or accepts the key. Mobile
 * layout only: the desktop keeps its corner notice.
 */
export function KeyChangeLine({ userId }: { userId: string }): React.JSX.Element {
  const name = useUserName(userId)
  return (
    <div className="px-3 pt-[5px] pb-1.5">
      <div
        role="note"
        className="border-feature-event/20 bg-feature-event/7 flex items-center gap-2.5 border py-2.5 pr-2.5 pl-3"
      >
        <KeyRound className="text-feature-event size-4 shrink-0" aria-hidden />
        <div className="grid min-w-0 flex-1 gap-0.5 break-words text-pretty">
          <p className="text-feature-event-text text-[13.5px] leading-[1.3] font-bold">
            {name}’s security key changed.
          </p>
          <p className="text-text-secondary text-[12.5px] leading-[1.4] font-medium">
            {name} isn’t verified, so nothing is paused. Compare numbers to be sure.
          </p>
        </div>
        <button
          type="button"
          aria-label={`Compare safety numbers with ${name}`}
          onClick={() => openDialog({ kind: 'verification', userId })}
          className="rounded-control border-feature-event/25 bg-feature-event/14 text-feature-event-text active:bg-feature-event/25 focus-visible:outline-line-focus h-9 shrink-0 border px-3 text-[13.5px] font-extrabold outline-none focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          Compare
        </button>
      </div>
    </div>
  )
}
