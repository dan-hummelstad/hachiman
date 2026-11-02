import { WifiOff } from 'lucide-react'
import { LiveDots } from '@/components/security/screen-window'
import { clockTime, useConnectionLoss } from '@/components/system/connection-state'
import { hachiman } from '@/services/hachiman'

/**
 * Desktop: the reconnecting strip under the channel header (Three Questions 3H). `live`: the
 * client is trying right now. Renders nothing while connected.
 */
export function ConnectionBanner(): React.JSX.Element | null {
  const { lost, since } = useConnectionLoss()
  if (!lost) return null
  return (
    <div
      role="status"
      className="border-live bg-live-tint flex h-[45px] shrink-0 items-center gap-[11px] border-y px-6"
    >
      <LiveDots />
      <span className="text-live-text font-mono text-[9.5px] font-semibold tracking-[1.2px]">
        RECONNECTING
      </span>
      <span className="text-text-secondary truncate text-[12.5px]">
        Nothing is lost. Hachiman catches up when the connection is back.
      </span>
      <span className="flex-1" />
      {since !== null && (
        <span className="text-text-disabled font-mono text-[9px] tracking-[1px] whitespace-nowrap uppercase">
          Offline since {clockTime(since)}
        </span>
      )}
      <button
        type="button"
        onClick={() => hachiman.gateway.retryNow()}
        className="border-line-strong text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-line-focus rounded-[4px] border px-[9px] py-[5px] font-mono text-[9px] font-semibold tracking-[0.9px] outline-none focus-visible:outline-2"
      >
        TRY NOW
      </button>
    </div>
  )
}

/**
 * Mobile: the band above the tab strip (Three Questions F3). Neutral: nothing turns red when the
 * network is gone.
 */
export function MobileConnectionBand(): React.JSX.Element | null {
  const { lost, since } = useConnectionLoss()
  if (!lost) return null
  return (
    <div
      role="status"
      className="border-line-hairline bg-surface-selected flex h-8 shrink-0 items-center gap-2 border-b px-3.5"
    >
      <WifiOff aria-hidden className="text-text-tertiary size-[13px]" />
      <span className="text-text-secondary font-mono text-[9px] tracking-[1.1px]">
        RECONNECTING…
      </span>
      <span className="flex-1" />
      {since !== null && (
        <span className="text-text-disabled font-mono text-[9px] tracking-[1.1px]">
          LAST SYNCED {clockTime(since)}
        </span>
      )}
    </div>
  )
}
