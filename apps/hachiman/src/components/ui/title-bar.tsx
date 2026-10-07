import { cn } from '@/lib/utils'

/** 56px content header (Arc §6): title left, tools right, hairline rule below. */
function TitleBar({
  left,
  right,
  className
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-slot="title-bar"
      className={cn(
        'border-line-hairline flex h-14 shrink-0 items-center gap-3 border-b pr-3 pl-5 text-heading',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{left}</div>
      {right != null && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  )
}

export { TitleBar }
