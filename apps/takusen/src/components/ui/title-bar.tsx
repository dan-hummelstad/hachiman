import { cn } from '@/lib/utils'

/** 48px pane header (docs/ui-redesign.md §1): title left, tools right, 1px bottom rule. */
function TitleBar({
  left,
  right,
  className,
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-slot="title-bar"
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b px-3 text-[15px] leading-5 font-semibold',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
      {right != null && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </div>
  )
}

export { TitleBar }
