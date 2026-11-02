import { Ban, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLayout } from '@/hooks/use-layout'

const BODY = 'It was deleted, or you can no longer see it. Nothing in your other channels changed.'

/**
 * A channel that is selected but does not exist for this user any more (Three Questions 3I, F4).
 * Presentational: the mount site decides when it shows. `onLeave` goes to a channel that exists.
 */
export function ChannelGone({
  channelId,
  onLeave,
  leaveLabel,
  onCloseTab
}: {
  channelId: string
  onLeave?: () => void
  leaveLabel?: string
  onCloseTab?: () => void
}): React.JSX.Element {
  if (useLayout() === 'mobile') {
    return (
      <div className="flex flex-1 flex-col justify-center gap-4 px-[34px]">
        <span className="border-line-hairline bg-surface-sunken flex size-[76px] items-center justify-center rounded-full border">
          <Unlink aria-hidden className="text-text-disabled size-[26px]" />
        </span>
        <h2 className="text-text-primary text-[21px] font-semibold tracking-[-0.5px]">
          This channel is not here
        </h2>
        <p className="text-text-tertiary text-[13px] leading-[1.5]">{BODY}</p>
        <p className="text-text-disabled font-mono text-[8.5px] tracking-[1px] break-all uppercase">
          Channel id {channelId}
        </p>
        {onLeave && (
          <div className="flex flex-col gap-2.5 pt-2.5">
            <Button size="mobile" onClick={onLeave}>
              {leaveLabel ?? 'Go back'}
            </Button>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="relative isolate flex flex-1 flex-col overflow-hidden">
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 -z-10 -translate-x-1/2 -translate-y-1/2 text-[470px] leading-none font-semibold text-[color-mix(in_oklab,var(--text-primary)_4%,var(--surface-window))] select-none"
      >
        八
      </span>
      <div className="flex flex-1 flex-col items-center justify-center px-[120px] text-center">
        <span className="border-line-strong flex size-[74px] items-center justify-center rounded-[19px] border">
          <Ban aria-hidden className="text-text-disabled size-[30px]" />
        </span>
        <h2 className="text-text-primary mt-[26px] text-[26px] leading-[1.25] font-semibold tracking-[-0.7px]">
          This channel is not here any more
        </h2>
        <p className="text-text-tertiary mt-[11px] max-w-[540px] text-[14px] leading-[1.6]">
          {BODY}
        </p>
        <p className="text-text-disabled mt-5 font-mono text-[9.5px] tracking-[1.2px] break-all uppercase">
          Channel id {channelId}
        </p>
        {(onLeave || onCloseTab) && (
          <div className="mt-7 flex gap-2.5">
            {onLeave && <Button onClick={onLeave}>{leaveLabel ?? 'Go back'}</Button>}
            {onCloseTab && (
              <Button variant="quiet" size="sm" onClick={onCloseTab}>
                Close this tab
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="border-line-hairline text-text-disabled flex h-14 shrink-0 items-center justify-center border-t font-mono text-[9px] tracking-[1.2px] uppercase">
        Nothing can be written here
      </p>
    </div>
  )
}
