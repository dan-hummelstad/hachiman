import { SectionHeading } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { usePrefsStore, type MessageDisplay, type Theme } from '@/stores/prefsStore'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Match system' }
]

/** User settings → Appearance: theme + message display, each previewed. */
export function AppearanceSection(): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)

  return (
    <div className="grid gap-8">
      <section>
        <SectionHeading>Theme</SectionHeading>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
          {THEMES.map((t) => (
            <OptionCard
              key={t.value}
              checked={theme === t.value}
              onSelect={() => setTheme(t.value)}
              label={t.label}
            >
              <ThemeSwatch value={t.value} />
            </OptionCard>
          ))}
        </div>
      </section>
      <section>
        <SectionHeading>Message display</SectionHeading>
        <div role="radiogroup" aria-label="Message display" className="grid gap-3">
          {(['cozy', 'compact'] as MessageDisplay[]).map((d) => (
            <OptionCard
              key={d}
              checked={messageDisplay === d}
              onSelect={() => setMessageDisplay(d)}
              label={d === 'cozy' ? 'Cozy' : 'Compact'}
              hint={
                d === 'cozy'
                  ? 'Avatars and names above each group of messages.'
                  : 'One line per message, like an IRC log.'
              }
            >
              <TranscriptPreview display={d} />
            </OptionCard>
          ))}
        </div>
      </section>
    </div>
  )
}

function OptionCard(props: {
  checked: boolean
  onSelect: () => void
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      onClick={props.onSelect}
      className={cn(
        'bg-card grid gap-3 border p-3 text-left',
        props.checked
          ? 'border-primary outline-primary outline-1 outline-solid'
          : 'hover:border-muted-foreground'
      )}
    >
      {props.children}
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'flex size-4 shrink-0 items-center justify-center border',
            props.checked ? 'border-primary' : 'border-input'
          )}
        >
          {props.checked && <span className="bg-primary size-2" />}
        </span>
        <span className="grid">
          <span className="text-sm font-medium">{props.label}</span>
          {props.hint && (
            <span className="text-muted-foreground text-xs leading-4">{props.hint}</span>
          )}
        </span>
      </span>
    </button>
  )
}

/** Miniature of the app chrome, drawn with the real tokens of `scheme`. */
function MiniChrome({
  scheme,
  className
}: {
  scheme: 'dark' | 'light'
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn(scheme, 'bg-background flex h-full', className)}>
      <span className="bg-rail w-[14%]" />
      <span className="bg-sidebar w-[30%] border-r" />
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span className="bg-foreground/60 h-1 w-3/4" />
        <span className="bg-foreground/35 h-1 w-1/2" />
        <span className="bg-primary h-1 w-2/3" />
      </span>
    </span>
  )
}

function ThemeSwatch({ value }: { value: Theme }): React.JSX.Element {
  return (
    <span aria-hidden className="relative block h-16 overflow-hidden border">
      {value === 'system' ? (
        <>
          <MiniChrome scheme="light" className="absolute inset-0" />
          <MiniChrome
            scheme="dark"
            className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
          />
        </>
      ) : (
        <MiniChrome scheme={value} />
      )}
    </span>
  )
}

const SAMPLE = [
  { time: '10:42', author: 'alice', color: '#e0823d', text: 'anyone up for a game?' },
  { time: '10:42', author: 'alice', color: '#e0823d', text: 'lounge is open' },
  { time: '10:43', author: 'bob', color: '#4fa3e0', text: 'sure, in 5' }
]

function TranscriptPreview({ display }: { display: MessageDisplay }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="bg-background block border px-3 py-2 font-mono text-[13px] leading-[22px]"
    >
      {display === 'compact'
        ? SAMPLE.map((m, i) => (
            <span key={i} className="flex gap-3 whitespace-nowrap">
              <span className="text-muted-foreground w-10 shrink-0 font-sans text-xs leading-[22px] tabular-nums">
                {m.time}
              </span>
              <span className="w-12 shrink-0 text-right font-semibold" style={{ color: m.color }}>
                {m.author}
              </span>
              <span className="truncate">{m.text}</span>
            </span>
          ))
        : SAMPLE.map((m, i) => {
            const head = i === 0 || SAMPLE[i - 1].author !== m.author
            return (
              <span key={i} className={cn('flex gap-3', head && i > 0 && 'mt-2')}>
                <span className="w-6 shrink-0">
                  {head && (
                    <span
                      className="bg-accent mt-0.5 flex size-6 items-center justify-center font-sans text-[11px] font-semibold"
                      style={{ color: m.color }}
                    >
                      {m.author[0].toUpperCase()}
                    </span>
                  )}
                </span>
                <span className="grid min-w-0">
                  {head && (
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold" style={{ color: m.color }}>
                        {m.author}
                      </span>
                      <span className="text-muted-foreground font-sans text-xs tabular-nums">
                        {m.time}
                      </span>
                    </span>
                  )}
                  <span className="truncate">{m.text}</span>
                </span>
              </span>
            )
          })}
    </span>
  )
}
