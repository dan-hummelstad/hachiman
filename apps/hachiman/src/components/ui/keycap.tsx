import { cn } from '@/lib/utils'

/** A key or shortcut hint (`⌘K`, `Esc`) in IBM Plex Mono. */
export function Keycap({ className, ...props }: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      data-slot="keycap"
      className={cn(
        'rounded-check bg-surface-raised text-text-tertiary inline-flex h-5 min-w-5 items-center justify-center px-1.5 font-mono text-[11px] leading-none font-medium',
        className
      )}
      {...props}
    />
  )
}
