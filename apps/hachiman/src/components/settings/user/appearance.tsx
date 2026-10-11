import { useEffect, useId, useRef } from 'react'
import { SectionLabel } from '@/components/mobile/list'
import { GradientPicker, GradientPickerMobile } from '@/components/settings/user/gradient-picker'
import { TextSizeSection } from '@/components/settings/user/text-size'
import { setSidebarMode } from '@/components/shell/sidebar-state'
import { SectionHeading } from '@/components/ui/field'
import { Keycap } from '@/components/ui/keycap'
import { RadioCard } from '@/components/ui/radio-card'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { customWallpaper, FALLBACK_HUES, tintColors, tintWallpaper } from '@/lib/guild-tint'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import {
  usePrefsStore,
  type MessageDisplay,
  type SidebarMode,
  type SidebarSide,
  type Theme,
  type WallpaperMode
} from '@/stores/prefsStore'

const SIDES = [
  { value: 'left', label: 'Left side' },
  { value: 'right', label: 'Right side' }
] as const

const THEMES: { value: Theme; label: string; short: string }[] = [
  { value: 'dark', label: 'Dark', short: 'Dark' },
  { value: 'light', label: 'Light', short: 'Light' },
  { value: 'system', label: 'Match system', short: 'System' }
]

/** The guild tint preview uses the accent hue. */
const SAMPLE_TINT = tintColors(FALLBACK_HUES[0])
const SAMPLE_GUILD = {
  light: tintWallpaper(SAMPLE_TINT.light),
  dark: tintWallpaper(SAMPLE_TINT.dark)
}

/** User settings → Appearance: the desktop page (H5), or the phone screen (M31). */
export function AppearanceSection(): React.JSX.Element {
  return useLayout() === 'mobile' ? <AppearanceMobile /> : <AppearanceDesktop />
}

/**
 * H5: theme, sidebar (N3), message display and the window background, each a small preview.
 */
function AppearanceDesktop(): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)
  const sidebar = usePrefsStore((s) => s.sidebar)
  const side = usePrefsStore((s) => s.sidebarSide)
  const setSide = usePrefsStore((s) => s.setSidebarSide)
  const sidebarKey = useKeybindLabel('sidebar')

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
              preview={<SidebarPreview mode={m} side={side} />}
              description={
                m === 'docked' ? (
                  'Part of the window, always visible'
                ) : (
                  <>
                    Slides out at the {side} edge
                    {sidebarKey && (
                      <>
                        {' · '}
                        <Keycap className="h-4 bg-transparent px-0.5">{sidebarKey}</Keycap>
                      </>
                    )}
                  </>
                )
              }
            />
          ))}
        </div>
        <SegmentedControl<SidebarSide>
          label="Sidebar side"
          options={SIDES}
          value={side}
          onChange={setSide}
          className="mt-3 w-56"
        />
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
      <BackgroundSection />
    </div>
  )
}

/**
 * M31: theme as three cards, each a tiny copy of the phone, density as two cards with a
 * transcript, the text size, then the background. A phone has no sidebar choice.
 */
function AppearanceMobile(): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)
  const themeId = useId()
  const densityId = useId()

  return (
    <div className="grid gap-[18px]">
      <section className="flex flex-col gap-1.5">
        <SectionLabel id={themeId}>Theme</SectionLabel>
        <div role="radiogroup" aria-labelledby={themeId} className="grid grid-cols-3 gap-2.5">
          {THEMES.map((t) => (
            <RadioCard
              key={t.value}
              size="mobile"
              mark="foot"
              name="theme"
              checked={theme === t.value}
              onChange={() => setTheme(t.value)}
              title={t.short}
              preview={<PhoneSwatch value={t.value} />}
            />
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-1.5">
        <SectionLabel id={densityId}>Message density</SectionLabel>
        <div role="radiogroup" aria-labelledby={densityId} className="grid grid-cols-2 gap-2.5">
          {(['cozy', 'compact'] as MessageDisplay[]).map((d) => (
            <RadioCard
              key={d}
              size="mobile"
              mark="foot"
              name="message-display"
              checked={messageDisplay === d}
              onChange={() => setMessageDisplay(d)}
              title={d === 'cozy' ? 'Cozy' : 'Compact'}
              preview={<TranscriptPreview display={d} size="mobile" />}
              description={d === 'cozy' ? 'Avatars and names' : 'One line each'}
            />
          ))}
        </div>
      </section>
      <TextSizeSection />
      <BackgroundSectionMobile />
    </div>
  )
}

/**
 * M31 BACKGROUND: the wallpaper behind the tab strip and the status bar, as two phone cards. The
 * custom gradient opens its editor inline below them, so the nav bar and the status bar above
 * show each change live.
 */
function BackgroundSectionMobile(): React.JSX.Element {
  const wallpaper = usePrefsStore((s) => s.wallpaper)
  const setWallpaper = usePrefsStore((s) => s.setWallpaper)
  const gradient = usePrefsStore((s) => s.customGradient)
  const setGradient = usePrefsStore((s) => s.setCustomGradient)
  const labelId = useId()
  const editor = useRef<HTMLDivElement>(null)
  // Only a tap on Custom scrolls the editor into view, not opening the screen with it shown.
  const reveal = useRef(false)
  const custom = customWallpaper(gradient)

  useEffect(() => {
    if (wallpaper !== 'custom' || !reveal.current) return
    reveal.current = false
    editor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [wallpaper])

  // min-w-0: the swatch row scrolls; it must not widen the grid column of the screen.
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel id={labelId}>Background</SectionLabel>
      <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-2 gap-2.5">
        {(['guild', 'custom'] as WallpaperMode[]).map((m) => (
          <RadioCard
            key={m}
            size="mobile"
            mark="foot"
            name="wallpaper"
            checked={wallpaper === m}
            onChange={() => {
              reveal.current = m === 'custom'
              setWallpaper(m)
            }}
            title={m === 'guild' ? 'Guild colour' : 'Custom gradient'}
            preview={
              <PhoneSwatch
                value="system"
                wallpaper={m === 'guild' ? SAMPLE_GUILD : { light: custom, dark: custom }}
              />
            }
            description={m === 'guild' ? 'Tinted by each guild' : 'Your own colours'}
          />
        ))}
      </div>
      {wallpaper === 'custom' && (
        <div ref={editor} className="mt-1 scroll-mb-4">
          <GradientPickerMobile value={gradient} onChange={setGradient} />
        </div>
      )}
    </section>
  )
}

/** The window wallpaper: the guild tint (N4) or the user's own gradient, in both themes. */
function BackgroundSection(): React.JSX.Element {
  const wallpaper = usePrefsStore((s) => s.wallpaper)
  const setWallpaper = usePrefsStore((s) => s.setWallpaper)
  const gradient = usePrefsStore((s) => s.customGradient)
  const setGradient = usePrefsStore((s) => s.setCustomGradient)
  const custom = customWallpaper(gradient)

  return (
    <section>
      <SectionHeading>Background</SectionHeading>
      <div role="radiogroup" aria-label="Background" className="grid grid-cols-2 gap-3">
        {(['guild', 'custom'] as WallpaperMode[]).map((m) => (
          <RadioCard
            key={m}
            name="wallpaper"
            checked={wallpaper === m}
            onChange={() => setWallpaper(m)}
            title={m === 'guild' ? 'Guild colour' : 'Custom gradient'}
            preview={
              <WallpaperSwatch
                light={m === 'guild' ? SAMPLE_GUILD.light : custom}
                dark={m === 'guild' ? SAMPLE_GUILD.dark : custom}
              />
            }
            description={
              m === 'guild' ? 'Tinted by the icon of each guild' : 'Your colours, everywhere'
            }
          />
        ))}
      </div>
      {wallpaper === 'custom' && (
        <div className="rounded-option border-line-hairline mt-4 border p-4">
          <GradientPicker value={gradient} onChange={setGradient} />
        </div>
      )}
    </section>
  )
}

/** The window, light at the top left and dark at the bottom right, on a wallpaper when given. */
function WallpaperSwatch({ light, dark }: { light?: string; dark?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="rounded-control border-line-hairline relative block h-20 overflow-hidden border"
    >
      <MiniChrome scheme="light" className="absolute inset-0" style={{ backgroundImage: light }} />
      <MiniChrome
        scheme="dark"
        className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
        style={{ backgroundImage: dark }}
      />
    </span>
  )
}

/**
 * Miniature of the Arc window in `scheme`, drawn with its real tokens: the sidebar on the
 * wallpaper, then the content card.
 */
function MiniChrome({
  scheme,
  className,
  style
}: {
  scheme: 'dark' | 'light'
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <span className={cn(scheme, 'bg-surface-window flex h-full', className)} style={style}>
      <span className="flex w-[28%] shrink-0 flex-col gap-1 p-1.5">
        <span className="bg-text-tertiary/50 h-1 w-3/4" />
        <span className="bg-accent-primary h-1 w-2/3" />
        <span className="bg-text-tertiary/35 h-1 w-1/2" />
      </span>
      <span className="bg-surface-content border-line-hairline my-1 mr-1 flex flex-1 flex-col gap-1 border p-1.5">
        <span className="bg-text-primary/60 h-1 w-3/4" />
        <span className="bg-text-primary/35 h-1 w-1/2" />
      </span>
    </span>
  )
}

function ThemeSwatch({ value }: { value: Theme }): React.JSX.Element {
  if (value === 'system') return <WallpaperSwatch />
  return (
    <span
      aria-hidden
      className="rounded-control border-line-hairline relative block h-20 overflow-hidden border"
    >
      <MiniChrome scheme={value} />
    </span>
  )
}

/** The dots and line widths of the three messages of `MiniPhone`. */
const MINI_ROWS = [
  { dot: 'bg-feature-voice', lines: [30, 24] },
  { dot: 'bg-feature-danger', lines: [34, 18], accent: true },
  { dot: 'bg-feature-thread', lines: [28, 32] }
]

/**
 * A 54 × 116 copy of the phone in `scheme`, drawn with its real tokens: the island, the tab strip
 * on the tinted window (or on `wallpaper`), then the chat card with three messages, the voice bar
 * and the composer.
 */
function MiniPhone({
  scheme,
  wallpaper,
  className
}: {
  scheme: 'dark' | 'light'
  wallpaper?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      style={wallpaper ? { backgroundImage: wallpaper } : undefined}
      className={cn(
        scheme,
        'border-line-sheet to-surface-window flex h-[116px] w-[54px] flex-col overflow-hidden rounded-[11px] border bg-linear-to-b from-[color-mix(in_oklab,var(--accent-primary)_20%,var(--surface-window))]',
        className
      )}
    >
      <span className="mx-auto mt-1 h-[5px] w-4 shrink-0 rounded-[2px] bg-black" />
      <span className="mt-[3px] flex shrink-0 gap-[3px] px-[5px]">
        <span className="bg-fill-control-strong h-[5px] w-1.5 rounded-[1.5px]" />
        <span className="bg-accent-primary/55 h-[5px] w-4 rounded-[1.5px]" />
        <span className="bg-fill-control-strong h-[5px] w-4 rounded-[1.5px]" />
      </span>
      <span className="bg-surface-content mt-1 flex flex-1 flex-col px-[3px] py-[5px]">
        <span className="bg-text-primary/35 mx-0.5 h-[3px] w-[22px]" />
        <span className="mt-1.5 flex flex-col gap-[7px] px-0.5">
          {MINI_ROWS.map((row, i) => (
            <span key={i} className="flex gap-[3px]">
              <span className={cn('size-1.5 shrink-0 rounded-full', row.dot)} />
              <span className="flex flex-col gap-0.5">
                {row.lines.map((w, j) => (
                  <span
                    key={j}
                    className={cn(
                      'h-[3px]',
                      row.accent && j === 1 ? 'bg-accent-primary' : 'bg-text-primary/18'
                    )}
                    style={{ width: w }}
                  />
                ))}
              </span>
            </span>
          ))}
        </span>
        <span className="bg-feature-voice/25 mt-auto h-2 shrink-0" />
        <span className="bg-fill-control mt-[3px] h-[9px] shrink-0 rounded-[4.5px]" />
        <span className="bg-text-primary/60 mx-auto mt-[5px] h-0.5 w-4 shrink-0 rounded-full" />
      </span>
    </span>
  )
}

/**
 * The M31 theme preview: the phone in the theme; System is dark on the left, light on the right.
 * A `wallpaper` replaces the built-in tint, per scheme.
 */
function PhoneSwatch({
  value,
  wallpaper
}: {
  value: Theme
  wallpaper?: { light: string; dark: string }
}): React.JSX.Element {
  const scheme = value === 'light' ? 'light' : 'dark'
  return (
    <span aria-hidden className="bg-surface-sunken flex h-32 items-center justify-center">
      <span className="relative flex">
        <MiniPhone scheme={scheme} wallpaper={wallpaper?.[scheme]} />
        {value === 'system' && (
          <MiniPhone
            scheme="light"
            wallpaper={wallpaper?.light}
            className="absolute inset-0 [clip-path:inset(0_0_0_50%)]"
          />
        )}
      </span>
    </span>
  )
}

/** The window with the sidebar docked beside the content, or slid out over it from its edge. */
function SidebarPreview({
  mode,
  side
}: {
  mode: SidebarMode
  side: SidebarSide
}): React.JSX.Element {
  const right = side === 'right'
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
      className={cn(
        'rounded-control border-line-hairline bg-surface-window relative flex h-20 overflow-hidden border',
        right && 'flex-row-reverse'
      )}
    >
      {mode === 'docked' ? (
        <>
          <span className="w-[28%] shrink-0">{lines}</span>
          <span
            className={cn(
              'bg-surface-content border-line-hairline my-1 flex-1 border',
              right ? 'ml-1' : 'mr-1'
            )}
          >
            {lines}
          </span>
        </>
      ) : (
        <>
          <span
            className={cn(
              'bg-accent-primary absolute inset-y-1 z-10 w-0.5',
              right ? 'right-0' : 'left-0'
            )}
          />
          <span className="bg-surface-content border-line-hairline m-1 flex-1 border">{lines}</span>
          <span
            className={cn(
              'bg-surface-raised border-line-strong absolute inset-y-2 w-[28%] border shadow-lg',
              right ? 'right-1' : 'left-1'
            )}
          >
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

/** The M31 density previews: fewer and shorter lines for a 160 card. */
const MOBILE_COZY = [
  {
    time: '10:42',
    author: 'marlowe',
    ink: 'text-feature-event-text',
    dot: 'bg-feature-voice',
    text: 'up for a game?'
  },
  {
    time: '10:43',
    author: 'Juni',
    ink: 'text-feature-activity',
    dot: 'bg-feature-danger',
    text: 'sure, in 5'
  }
]
const MOBILE_COMPACT = [
  { time: '10:42', author: 'marlowe', ink: 'text-feature-event-text', text: 'anyone up?' },
  { time: '10:42', author: 'marlowe', ink: 'text-feature-event-text', text: 'lounge open' },
  { time: '10:43', author: 'Juni', ink: 'text-feature-activity', text: 'sure, in 5' },
  { time: '10:44', author: 'kestrel', ink: 'text-feature-activity', text: 'on my way' }
]

function TranscriptPreview({
  display,
  size = 'default'
}: {
  display: MessageDisplay
  size?: 'default' | 'mobile'
}): React.JSX.Element {
  if (size === 'mobile') return <MobileTranscriptPreview display={display} />
  return (
    <span
      aria-hidden
      className="rounded-control bg-surface-window border-line-hairline block h-[92px] overflow-hidden border px-3 py-2 text-[12.5px] leading-5"
    >
      {display === 'compact'
        ? SAMPLE.map((m, i) => (
            <span key={i} className="flex gap-3 whitespace-nowrap">
              <span className="text-text-secondary w-10 shrink-0 text-xs leading-5 tabular-nums">
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
                  'bg-surface-hover mt-0.5 flex size-6 shrink-0 items-center justify-center text-[11px] font-semibold',
                  m.ink
                )}
              >
                {m.author[0].toUpperCase()}
              </span>
              <span className="grid min-w-0 leading-[17px]">
                <span className="flex items-baseline gap-2">
                  <span className={cn('font-semibold', m.ink)}>{m.author}</span>
                  <span className="text-text-secondary text-[11px] tabular-nums">{m.time}</span>
                </span>
                <span className="truncate">{m.text}</span>
              </span>
            </span>
          ))}
    </span>
  )
}

function MobileTranscriptPreview({ display }: { display: MessageDisplay }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-surface-panel flex h-[90px] flex-col overflow-hidden p-2.5',
        display === 'compact' ? 'gap-1.5' : 'gap-2'
      )}
    >
      {display === 'compact'
        ? MOBILE_COMPACT.map((m, i) => (
            <span key={i} className="flex items-baseline gap-1 text-[10.5px] leading-[13px]">
              <span className="text-text-tertiary w-[25px] shrink-0 text-[9.5px] font-semibold tabular-nums">
                {m.time}
              </span>
              <span className={cn('w-[46px] shrink-0 truncate text-right font-extrabold', m.ink)}>
                {m.author}
              </span>
              <span className="text-text-primary min-w-0 truncate font-medium">{m.text}</span>
            </span>
          ))
        : MOBILE_COZY.map((m, i) => (
            <span key={i} className="flex gap-2">
              <span
                className={cn(
                  'text-surface-window flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold',
                  m.dot
                )}
              >
                {m.author[0].toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-col gap-px text-[11.5px] leading-[14px]">
                <span className="flex items-baseline gap-[5px]">
                  <span className={cn('font-extrabold', m.ink)}>{m.author}</span>
                  <span className="text-text-tertiary text-[9.5px] font-semibold tabular-nums">
                    {m.time}
                  </span>
                </span>
                <span className="text-text-primary truncate font-medium">{m.text}</span>
              </span>
            </span>
          ))}
    </span>
  )
}
