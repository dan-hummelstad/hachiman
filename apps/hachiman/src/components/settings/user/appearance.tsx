import { useId, useState } from 'react'
import { ThemeEditor, ThemeEditorScreen } from '@/components/settings/user/theme-editor'
import { ThemeGallery, ThemeListMobile } from '@/components/settings/user/theme-gallery'
import { MobileCap, SettingsCap, SettingsRule } from '@/components/settings/user/rows'
import { usePushScreen } from '@/components/mobile/pushed-screen'
import { TextSizeSection } from '@/components/settings/user/text-size'
import { setSidebarMode } from '@/components/shell/sidebar-state'
import { Keycap } from '@/components/ui/keycap'
import { RadioCard } from '@/components/ui/radio-card'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useLayout } from '@/hooks/use-layout'
import type { ThemeRecipe } from '@/lib/theme-engine'
import { cn } from '@/lib/utils'
import {
  usePrefsStore,
  type MessageDisplay,
  type SidebarMode,
  type SidebarSide
} from '@/stores/prefsStore'

const SIDES = [
  { value: 'left', label: 'Left side' },
  { value: 'right', label: 'Right side' }
] as const

/** User settings -> Appearance: the desktop page, or the phone screen. */
export function AppearanceSection(): React.JSX.Element {
  return useLayout() === 'mobile' ? <AppearanceMobile /> : <AppearanceDesktop />
}

/**
 * Themes (the gallery, or the editor of one theme in its place), the sidebar and the message
 * display, each a small preview.
 */
function AppearanceDesktop(): React.JSX.Element {
  const [editing, setEditing] = useState<ThemeRecipe | null>(null)
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)
  const sidebar = usePrefsStore((s) => s.sidebar)
  const side = usePrefsStore((s) => s.sidebarSide)
  const setSide = usePrefsStore((s) => s.setSidebarSide)
  const sidebarKey = useKeybindLabel('sidebar')

  if (editing) {
    return (
      <ThemeEditor
        key={editing.id}
        initial={editing}
        onDone={() => setEditing(null)}
        onEdit={setEditing}
      />
    )
  }

  return (
    <div>
      <section>
        <SettingsCap className="mb-3">Themes</SettingsCap>
        <ThemeGallery onEdit={setEditing} />
      </section>
      <SettingsRule />
      <section>
        <SettingsCap className="mb-3">Sidebar</SettingsCap>
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
      <SettingsRule />
      <section>
        <SettingsCap className="mb-3">Message display</SettingsCap>
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

/**
 * The themes as cards (the editor is a pushed screen), the density as two cards with a
 * transcript, then the text size. A phone has no sidebar choice.
 */
function AppearanceMobile(): React.JSX.Element {
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)
  const { push } = usePushScreen()
  const densityId = useId()

  return (
    <div className="grid gap-[18px]">
      <ThemeListMobile onEdit={(r) => push(<ThemeEditorScreen initial={r} />)} />
      <section className="flex flex-col gap-1.5">
        <MobileCap id={densityId}>Message density</MobileCap>
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
    </div>
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
      <span className="bg-here h-1 w-2/3" />
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
              'bg-here absolute inset-y-1 z-10 w-0.5',
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
    ink: 'text-text-primary',
    text: 'anyone up for a game?'
  },
  { time: '10:42', author: 'marlowe', ink: 'text-text-primary', text: 'lounge is open' },
  { time: '10:43', author: 'Juni', ink: 'text-text-primary', text: 'sure, in 5' }
]
// Cozy shows one line per author, so that both groups fit the preview.
const COZY_SAMPLE = SAMPLE.filter((m, i) => i === 0 || SAMPLE[i - 1].author !== m.author)

/** The M31 density previews: fewer and shorter lines for a 160 card. */
const MOBILE_COZY = [
  {
    time: '10:42',
    author: 'marlowe',
    ink: 'text-text-primary',
    dot: 'bg-avatar-2',
    text: 'up for a game?'
  },
  {
    time: '10:43',
    author: 'Juni',
    ink: 'text-text-primary',
    dot: 'bg-avatar-3',
    text: 'sure, in 5'
  }
]
const MOBILE_COMPACT = [
  { time: '10:42', author: 'marlowe', ink: 'text-text-primary', text: 'anyone up?' },
  { time: '10:42', author: 'marlowe', ink: 'text-text-primary', text: 'lounge open' },
  { time: '10:43', author: 'Juni', ink: 'text-text-primary', text: 'sure, in 5' },
  { time: '10:44', author: 'kestrel', ink: 'text-text-primary', text: 'on my way' }
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
        'bg-surface-panel flex h-[90px] flex-col overflow-hidden px-2 py-2.5',
        display === 'compact' ? 'gap-1.5' : 'gap-2'
      )}
    >
      {display === 'compact'
        ? MOBILE_COMPACT.map((m, i) => (
            <span key={i} className="flex items-baseline gap-1 text-[10.5px] leading-[13px]">
              <span className="text-text-tertiary w-[27px] shrink-0 text-[9.5px] font-semibold tabular-nums">
                {m.time}
              </span>
              <span className={cn('w-[46px] shrink-0 truncate text-right font-semibold', m.ink)}>
                {m.author}
              </span>
              <span className="text-text-primary min-w-0 truncate font-medium">{m.text}</span>
            </span>
          ))
        : MOBILE_COZY.map((m, i) => (
            <span key={i} className="flex gap-2">
              <span
                className={cn(
                  'text-text-secondary flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                  m.dot
                )}
              >
                {m.author[0].toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-col gap-px text-[11.5px] leading-[14px]">
                <span className="flex items-baseline gap-[5px]">
                  <span className={cn('font-semibold', m.ink)}>{m.author}</span>
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
