import { cn } from '@/lib/utils'

/** A key or shortcut hint (`⌘K`, `Esc`) in JetBrains Mono. */
export function Keycap({ className, ...props }: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      data-slot="keycap"
      className={cn(
        'border-line-strong text-text-tertiary inline-flex min-w-5 items-center justify-center rounded-[4px] border px-[5px] py-[3px] font-mono text-[10px] leading-none',
        className
      )}
      {...props}
    />
  )
}
