import { cn } from '@/lib/utils'

/** 60px content header: title left, tools right, hairline rule below. */
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
        'border-line-hairline text-heading flex h-[60px] shrink-0 items-center gap-3 border-b pr-5 pl-6',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">{left}</div>
      {right != null && <div className="flex shrink-0 items-center gap-3.5">{right}</div>}
    </div>
  )
}

export { TitleBar }
