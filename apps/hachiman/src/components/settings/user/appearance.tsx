import { setSidebarMode } from '@/components/shell/sidebar-state'
import { SectionHeading } from '@/components/ui/field'
import { Keycap } from '@/components/ui/keycap'
import { RadioCard } from '@/components/ui/radio-card'
import { MOD_KEY } from '@/lib/mod-key'
import { cn } from '@/lib/utils'
import {
  usePrefsStore,
  type MessageDisplay,
  type SidebarMode,
  type Theme
} from '@/stores/prefsStore'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Match system' }
]

/** User settings → Appearance (H5): theme, sidebar (N3) and message display, each a small preview. */
export function AppearanceSection(): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)
  const sidebar = usePrefsStore((s) => s.sidebar)

  return (
    <div className="grid gap-8">
      <section>
        <SectionHeading>Theme</SectionHeading>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
          {THEMES.map((t) => (
            <RadioCard
              key={t.value}
              name="theme"
              checked={theme === t.value}
              onChange={() => setTheme(t.value)}
              title={t.label}
              preview={<ThemeSwatch value={t.value} />}
            />
          ))}
        </div>
      </section>
      <section>
        <SectionHeading>Sidebar</SectionHeading>
        <div role="radiogroup" aria-label="Sidebar" className="grid grid-cols-2 gap-3">
          {(['docked', 'undocked'] as SidebarMode[]).map((m) => (
            <RadioCard
              key={m}
              name="sidebar"
              checked={sidebar === m}
              onChange={() => setSidebarMode(m)}
              title={m === 'docked' ? 'Docked' : 'Undocked'}
              preview={<SidebarPreview mode={m} />}
              description={
                m === 'docked' ? (
                  'Part of the window, always visible'
                ) : (
                  <>
                    Slides out at the left edge ·{' '}
                    <Keycap className="h-4 bg-transparent px-0.5">{MOD_KEY}S</Keycap>
                  </>
                )
              }
            />
          ))}
        </div>
      </section>
      <section>
        <SectionHeading>Message display</SectionHeading>
        <div role="radiogroup" aria-label="Message display" className="grid grid-cols-2 gap-3">
          {(['cozy', 'compact'] as MessageDisplay[]).map((d) => (
            <RadioCard
              key={d}
              name="message-display"
              checked={messageDisplay === d}
              onChange={() => setMessageDisplay(d)}
              title={d === 'cozy' ? 'Cozy' : 'Compact'}
              preview={<TranscriptPreview display={d} />}
              description={
                d === 'cozy'
                  ? 'Avatars and names above each group'
                  : 'One line per message, like an IRC log'
              }
            />
          ))}
        </div>
      </section>
    </div>
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
    <span
      aria-hidden
      className="rounded-control border-line-hairline relative block h-20 overflow-hidden border"
    >
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

/** The window with the sidebar docked beside the content, or slid out over it from the left edge. */
function SidebarPreview({ mode }: { mode: SidebarMode }): React.JSX.Element {
  const lines = (
    <span className="flex flex-col gap-1.5 p-2">
      <span className="bg-text-tertiary/50 h-1 w-3/4" />
      <span className="bg-text-tertiary/35 h-1 w-1/2" />
      <span className="bg-accent-primary h-1 w-2/3" />
      <span className="bg-text-tertiary/35 h-1 w-3/5" />
    </span>
  )
  return (
    <span
      aria-hidden
      className="rounded-control border-line-hairline bg-surface-window relative flex h-20 overflow-hidden border"
    >
      {mode === 'docked' ? (
        <>
          <span className="w-[28%] shrink-0">{lines}</span>
          <span className="bg-surface-content border-line-hairline my-1 mr-1 flex-1 border">
            {lines}
          </span>
        </>
      ) : (
        <>
          <span className="bg-accent-primary absolute inset-y-1 left-0 z-10 w-0.5" />
          <span className="bg-surface-content border-line-hairline m-1 flex-1 border">{lines}</span>
          <span className="bg-surface-raised border-line-strong absolute inset-y-2 left-1 w-[28%] border shadow-lg">
            {lines}
          </span>
        </>
      )}
    </span>
  )
}

const SAMPLE = [
  {
    time: '10:42',
    author: 'marlowe',
    ink: 'text-feature-event-text',
    text: 'anyone up for a game?'
  },
  { time: '10:42', author: 'marlowe', ink: 'text-feature-event-text', text: 'lounge is open' },
  { time: '10:43', author: 'Juni', ink: 'text-feature-danger-text', text: 'sure, in 5' }
]
// Cozy shows one line per author, so that both groups fit the preview.
const COZY_SAMPLE = SAMPLE.filter((m, i) => i === 0 || SAMPLE[i - 1].author !== m.author)

function TranscriptPreview({ display }: { display: MessageDisplay }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="rounded-control bg-surface-window border-line-hairline block h-[92px] overflow-hidden border px-3 py-2 text-[12.5px] leading-5"
    >
      {display === 'compact'
        ? SAMPLE.map((m, i) => (
            <span key={i} className="flex gap-3 whitespace-nowrap">
              <span className="text-muted-foreground w-10 shrink-0 text-xs leading-5 tabular-nums">
                {m.time}
              </span>
              <span className={cn('w-14 shrink-0 text-right font-semibold', m.ink)}>
                {m.author}
              </span>
              <span className="truncate">{m.text}</span>
            </span>
          ))
        : COZY_SAMPLE.map((m, i) => (
            <span key={i} className={cn('flex gap-3', i > 0 && 'mt-1.5')}>
              <span
                className={cn(
                  'bg-accent mt-0.5 flex size-6 shrink-0 items-center justify-center text-[11px] font-semibold',
                  m.ink
                )}
              >
                {m.author[0].toUpperCase()}
              </span>
              <span className="grid min-w-0 leading-[17px]">
                <span className="flex items-baseline gap-2">
                  <span className={cn('font-semibold', m.ink)}>{m.author}</span>
                  <span className="text-muted-foreground text-[11px] tabular-nums">{m.time}</span>
                </span>
                <span className="truncate">{m.text}</span>
              </span>
            </span>
          ))}
    </span>
  )
}
