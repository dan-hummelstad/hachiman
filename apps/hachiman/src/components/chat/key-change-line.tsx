import { KeyRound } from 'lucide-react'
import { useUserName } from '@/components/security/use-user-name'
import { openDialog } from '@/stores/dialogStore'

/**
 * M59: the security key of the other person of a 1:1 DM changed, and they were never verified,
 * so nothing is paused. A `you` card in the transcript (placed by `keyChangeSlot`) with Compare,
 * which opens the safety numbers. It goes when the user verifies or accepts the key. Mobile
 * layout only: the desktop keeps its corner notice.
 */
export function KeyChangeLine({ userId }: { userId: string }): React.JSX.Element {
  const name = useUserName(userId)
  return (
    <div className="px-3 pt-[5px] pb-1.5">
      <div
        role="note"
        className="border-you/40 bg-you-tint rounded-option flex items-center gap-2.5 border py-2.5 pr-2.5 pl-3"
      >
        <KeyRound className="text-you-text size-4 shrink-0" aria-hidden />
        <div className="grid min-w-0 flex-1 gap-0.5 break-words text-pretty">
          <p className="text-you-text text-[13.5px] leading-[1.3] font-semibold">
            {name}’s security key changed.
          </p>
          <p className="text-text-secondary text-[12.5px] leading-[1.4]">
            {name} isn’t verified, so nothing is paused. Compare numbers to be sure.
          </p>
        </div>
        <button
          type="button"
          aria-label={`Compare safety numbers with ${name}`}
          onClick={() => openDialog({ kind: 'verification', userId })}
          className="rounded-control border-you text-you-text active:bg-you-tint focus-visible:outline-line-focus h-9 shrink-0 border px-3 text-[13.5px] font-semibold outline-none focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          Compare
        </button>
      </div>
    </div>
  )
}
