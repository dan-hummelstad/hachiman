import { Callout } from '@/components/ui/callout'
import { cn } from '@/lib/utils'

/**
 * A full-window screen with one centred old-messenger window, as the sign-in screen. The
 * encryption onboarding and the fatal screens use it in place of the shell.
 */
export function ScreenWindow({
  title,
  children,
  wide,
  tone = 'default'
}: {
  title: string
  children: React.ReactNode
  wide?: boolean
  tone?: 'default' | 'danger'
}): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-0 w-full flex-1 items-center justify-center overflow-y-auto p-4">
      <section
        aria-labelledby="screen-window-title"
        className={cn(
          'bg-popover text-foreground my-auto w-full border shadow-lg',
          wide ? 'max-w-[520px]' : 'max-w-[400px]'
        )}
      >
        <header className="bg-sidebar flex h-10 items-center gap-2 border-b px-3">
          <span
            aria-hidden
            className={cn('size-3', tone === 'danger' ? 'bg-destructive' : 'bg-primary')}
          />
          <h1 id="screen-window-title" className="text-sm leading-5 font-semibold">
            {title}
          </h1>
        </header>
        <div className="grid gap-4 p-5">{children}</div>
      </section>
    </div>
  )
}

/** A short warning box inside a window or a settings page. */
export function Warning({
  children,
  tone = 'warning'
}: {
  children: React.ReactNode
  tone?: 'warning' | 'danger' | 'info'
}): React.JSX.Element {
  return <Callout tone={tone === 'warning' ? 'caution' : tone}>{children}</Callout>
}
