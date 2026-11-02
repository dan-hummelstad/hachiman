import { useId, useMemo, useState } from 'react'
import { ArrowLeft, Copy, Ellipsis, Pin, Pipette, RotateCcw, Share2, Trash2 } from 'lucide-react'
import { NavAction, NavActionButton } from '@/components/mobile/nav-bar'
import { MobileFoot } from '@/components/mobile/foot'
import { MobileField } from '@/components/mobile/field'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetItem,
  MenuSheetTrigger
} from '@/components/mobile/menu-sheet'
import { PushedScreen, usePushScreen } from '@/components/mobile/pushed-screen'
import { TouchRange } from '@/components/mobile/touch-range'
import { RangeInput, SettingsCap, SettingsRule } from '@/components/settings/user/rows'
import {
  forkTheme,
  RAMP_LABEL,
  shareText,
  SURFACE_KEYS,
  switchGround,
  TEXT_KEYS
} from '@/components/settings/user/theme-recipe'
import { LockedHues, ThemeMock } from '@/components/settings/user/theme-mock'
import { useThemeDraft, type ThemeDraft } from '@/components/settings/user/use-themes'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useCopy } from '@/hooks/use-copy'
import {
  deriveTheme,
  type Ground,
  type RampKey,
  type ThemeRecipe,
  type ThemeTokens
} from '@/lib/theme-engine'
import { cn } from '@/lib/utils'
import { usePrefsStore } from '@/stores/prefsStore'

const GROUNDS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
] as const

const CAP = 'text-text-disabled font-mono text-[8.5px] tracking-[1.2px] uppercase'

const tintLabel = (r: ThemeRecipe): string => `${Math.round(r.tint * 100)}%`
const separationLabel = (r: ThemeRecipe): string => `${r.separation.toFixed(2)}×`

/** One colour: a swatch, a title and the hex; the whole row opens the colour picker. */
function ColourRow({
  title,
  value,
  onChange,
  mobile
}: {
  title: string
  value: string
  onChange: (hex: string) => void
  mobile?: boolean
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'bg-surface-sunken relative flex cursor-pointer items-center gap-3 border',
        mobile
          ? 'border-line-strong rounded-[14px] px-[13px] py-3'
          : 'border-line-hairline rounded-control h-[52px] px-3'
      )}
    >
      <input
        type="color"
        value={value.toLowerCase()}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          'border-line-hairline shrink-0 border',
          mobile ? 'size-[22px] rounded-[6px]' : 'size-7 rounded-[6px]'
        )}
        style={{ background: value }}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'text-text-primary block font-semibold',
            mobile ? 'text-[13.5px]' : 'text-[12.5px]'
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            'font-mono uppercase',
            mobile ? 'text-here-text text-[10px]' : 'text-text-disabled text-[9px]'
          )}
        >
          {value}
        </span>
      </span>
      {!mobile && <Pipette aria-hidden className="text-text-tertiary size-[15px]" />}
      <span
        aria-hidden
        className="peer-focus-visible:outline-line-focus pointer-events-none absolute inset-0 rounded-[inherit] peer-focus-visible:outline-2"
      />
    </label>
  )
}

function SliderPanel({
  title,
  value,
  fraction,
  mobile,
  ...input
}: {
  title: string
  value: string
  fraction: number
  mobile?: boolean
} & Omit<React.ComponentProps<'input'>, 'type' | 'value'> & {
    current: number
  }): React.JSX.Element {
  const { current, ...rest } = input
  const id = useId()
  return (
    <div
      className={cn(
        'bg-surface-sunken flex flex-col gap-2 border',
        mobile
          ? 'border-line-strong rounded-[14px] px-[13px] py-3'
          : 'border-line-hairline rounded-control px-3 py-[11px]'
      )}
    >
      <label htmlFor={id} className="flex items-center">
        <span
          className={cn(
            'text-text-primary font-semibold',
            mobile ? 'text-[13.5px]' : 'text-[12.5px]'
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            'text-here-text ml-auto font-mono',
            mobile ? 'text-[10px]' : 'text-[9.5px]'
          )}
        >
          {value}
        </span>
      </label>
      {mobile ? (
        <TouchRange id={id} fraction={fraction} value={current} {...rest} />
      ) : (
        <RangeInput id={id} fraction={fraction} value={current} {...rest} />
      )}
    </div>
  )
}

/** The seven surfaces and four text levels of the theme, each pinnable. */
function Swatches({
  tokens,
  draft,
  setPin,
  patch
}: {
  tokens: ThemeTokens
  draft: ThemeRecipe
  setPin: ThemeDraft['setPin']
  patch: ThemeDraft['patch']
}): React.JSX.Element {
  const cell = (key: RampKey, tall: boolean): React.JSX.Element => {
    const pinned = key !== 'accent' && draft.pins?.[key] !== undefined
    const hex = tokens[key]
    return (
      <div key={key} className="flex flex-col gap-[7px]">
        <div className="relative">
          <label
            className={cn(
              'border-line-hairline rounded-control relative block cursor-pointer border',
              tall ? 'h-14' : 'h-11'
            )}
            style={{ background: hex }}
          >
            <span className="sr-only">{RAMP_LABEL[key]}</span>
            <input
              type="color"
              value={hex.toLowerCase()}
              onChange={(e) =>
                key === 'accent'
                  ? patch({ accent: e.target.value.toUpperCase() })
                  : setPin(key, e.target.value)
              }
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="peer-focus-visible:outline-line-focus pointer-events-none absolute inset-0 rounded-[inherit] peer-focus-visible:outline-2"
            />
          </label>
          {pinned && (
            <button
              type="button"
              aria-label={`Unpin ${RAMP_LABEL[key]}`}
              onClick={() => setPin(key, null)}
              className="bg-here absolute top-1.5 left-1.5 flex size-4 items-center justify-center rounded-full"
            >
              <Pin aria-hidden className="text-on-here size-[9px]" />
            </button>
          )}
        </div>
        <span>
          <span className="text-text-secondary block text-[11.5px] font-semibold">
            {RAMP_LABEL[key]}
          </span>
          <span className="text-text-disabled font-mono text-[8.5px] uppercase">{hex}</span>
        </span>
      </div>
    )
  }
  return (
    <>
      <div className="mt-3 grid grid-cols-7 gap-2.5">{SURFACE_KEYS.map((k) => cell(k, true))}</div>
      <div className="mt-3 grid grid-cols-5 gap-2.5">{TEXT_KEYS.map((k) => cell(k, false))}</div>
    </>
  )
}

/** The desktop editor: a recipe has three inputs, and any surface can be pinned by hand. */
export function ThemeEditor({
  initial,
  onDone,
  onEdit
}: {
  initial: ThemeRecipe
  /** Back to the gallery. */
  onDone: () => void
  /** Edit another recipe (after Duplicate). */
  onEdit: (recipe: ThemeRecipe) => void
}): React.JSX.Element {
  const { draft, patch, setPin, reset, dirty, save } = useThemeDraft(initial)
  const saveCustomTheme = usePrefsStore((s) => s.saveCustomTheme)
  const deleteCustomTheme = usePrefsStore((s) => s.deleteCustomTheme)
  const saved = usePrefsStore((s) => s.customThemes.some((t) => t.id === initial.id))
  const share = useCopy()
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null)
  const tokens = useMemo(() => deriveTheme(draft), [draft])
  const pinned = Object.keys(draft.pins ?? {}).length

  const back = (): void => (dirty ? setConfirm('discard') : onDone())
  const duplicate = (): void => {
    const copy = forkTheme(draft, `${draft.name} copy`)
    saveCustomTheme(copy)
    onEdit(copy)
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Button variant="quiet" size="sm" onClick={back}>
          <ArrowLeft aria-hidden /> All themes
        </Button>
        <span className="text-text-disabled font-mono text-[9px] tracking-[1.5px] uppercase">
          Themes / Editing
        </span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="relative">
          <span
            aria-hidden
            className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 rounded-full"
            style={{ background: draft.accent }}
          />
          <Input
            aria-label="Theme name"
            maxLength={40}
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="h-10 w-[260px] pl-8 text-[15px] font-semibold"
          />
        </div>
        <SegmentedControl<Ground>
          label="Ground"
          options={GROUNDS}
          value={draft.ground}
          onChange={(g) => patch(switchGround(draft, g))}
        />
        <span className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={duplicate}>
            <Copy aria-hidden /> Duplicate
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => share.copy(shareText(draft), 'share')}
          >
            <Share2 aria-hidden /> {share.copied ? 'Copied' : 'Share'}
          </Button>
          <Button variant="secondary" size="sm" disabled={!dirty} onClick={reset}>
            <RotateCcw aria-hidden /> Reset
          </Button>
          <Button size="sm" disabled={!dirty} onClick={save}>
            Save theme
          </Button>
          {saved && (
            <Button variant="danger" size="sm" onClick={() => setConfirm('delete')}>
              <Trash2 aria-hidden /> Delete
            </Button>
          )}
        </span>
      </div>
      <SettingsRule />
      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <p className={CAP}>Live — every surface below is in this picture</p>
          <ThemeMock recipe={draft} className="mt-[9px] h-[216px]" />
        </div>
        <div className="flex w-[330px] shrink-0 flex-col gap-3.5">
          <p className={CAP}>The three inputs</p>
          <ColourRow title="Base colour" value={draft.base} onChange={(base) => patch({ base })} />
          <ColourRow title="Accent" value={draft.accent} onChange={(accent) => patch({ accent })} />
          <SliderPanel
            title="Tint — hue in the greys"
            value={tintLabel(draft)}
            fraction={draft.tint / 0.3}
            current={draft.tint}
            min={0}
            max={0.3}
            step={0.01}
            onChange={(e) => patch({ tint: Number(e.target.value) })}
          />
          <SliderPanel
            title="Separation — space between surfaces"
            value={separationLabel(draft)}
            fraction={(draft.separation - 0.5) / 2}
            current={draft.separation}
            min={0.5}
            max={2.5}
            step={0.05}
            onChange={(e) => patch({ separation: Number(e.target.value) })}
          />
        </div>
      </div>
      <SettingsRule />
      <div className="flex items-center">
        <SettingsCap>Surfaces — all derived, any can be pinned</SettingsCap>
        {pinned > 0 && (
          <span className="text-here-text ml-auto font-mono text-[8.5px] uppercase">
            {pinned} pinned
          </span>
        )}
      </div>
      <Swatches tokens={tokens} draft={draft} setPin={setPin} patch={patch} />
      <SettingsRule />
      <LockedHues
        size="compact"
        note="A theme can recolour the whole app and still not touch what a mention looks like."
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        title="Discard your changes?"
        body="This theme has changes you have not saved."
        confirmLabel="Discard"
        tone="danger"
        onConfirm={async () => onDone()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete ${draft.name}?`}
        body="The theme is removed from this device. If it is in use, the app goes back to the built-in one."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          deleteCustomTheme(initial.id)
          onDone()
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}

/** The phone editor: a pushed screen over Appearance. Surfaces are shown, not pinned, here. */
export function ThemeEditorScreen({ initial }: { initial: ThemeRecipe }): React.JSX.Element {
  const { pop, push } = usePushScreen()
  const { draft, patch, reset, dirty, save } = useThemeDraft(initial)
  const saveCustomTheme = usePrefsStore((s) => s.saveCustomTheme)
  const deleteCustomTheme = usePrefsStore((s) => s.deleteCustomTheme)
  const saved = usePrefsStore((s) => s.customThemes.some((t) => t.id === initial.id))
  const share = useCopy()
  const nameId = useId()
  const tokens = useMemo(() => deriveTheme(draft), [draft])

  const duplicate = (): void => {
    const copy = forkTheme(draft, `${draft.name} copy`)
    saveCustomTheme(copy)
    push(<ThemeEditorScreen initial={copy} />)
  }
  const swatches: { key: RampKey; label: string }[] = [
    { key: 'window', label: 'Window' },
    { key: 'rail', label: 'Rail' },
    { key: 'sheet', label: 'Sheet' },
    { key: 'raised', label: 'Raised' },
    { key: 'sunken', label: 'Sunken' },
    { key: 'line', label: 'Line' },
    { key: 'accent', label: 'Accent' }
  ]

  return (
    <PushedScreen
      title={draft.name || 'Theme'}
      subtitle={`Editing · ${draft.ground} ground`}
      action={
        <NavAction>
          <MenuSheet>
            <MenuSheetTrigger asChild>
              <NavActionButton label="Theme actions">
                <Ellipsis />
              </NavActionButton>
            </MenuSheetTrigger>
            <MenuSheetContent title="Theme actions">
              <MenuSheetItem onSelect={duplicate}>
                <Copy aria-hidden /> Duplicate
              </MenuSheetItem>
              <MenuSheetItem onSelect={() => share.copy(shareText(draft), 'share')}>
                <Share2 aria-hidden /> {share.copied ? 'Copied' : 'Share'}
              </MenuSheetItem>
              <MenuSheetItem disabled={!dirty} onSelect={reset}>
                <RotateCcw aria-hidden /> Reset
              </MenuSheetItem>
              {saved && (
                <MenuSheetItem
                  variant="destructive"
                  onSelect={() => {
                    deleteCustomTheme(initial.id)
                    pop()
                  }}
                >
                  <Trash2 aria-hidden /> Delete theme
                </MenuSheetItem>
              )}
            </MenuSheetContent>
          </MenuSheet>
        </NavAction>
      }
      foot={
        <MobileFoot>
          <Button
            size="mobile"
            disabled={!dirty}
            onClick={() => {
              save()
              pop()
            }}
          >
            Save theme
          </Button>
        </MobileFoot>
      }
    >
      <div className="flex flex-col gap-3.5">
        <MobileField id={nameId} label="Name">
          <Input
            size="touch"
            maxLength={40}
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </MobileField>
        <SegmentedControl<Ground>
          size="touch"
          label="Ground"
          options={GROUNDS}
          value={draft.ground}
          onChange={(g) => patch(switchGround(draft, g))}
        />
        <p className={CAP}>Live preview</p>
        <ThemeMock recipe={draft} className="h-[150px]" />
        <ColourRow
          mobile
          title="Base colour"
          value={draft.base}
          onChange={(base) => patch({ base })}
        />
        <ColourRow
          mobile
          title="Accent"
          value={draft.accent}
          onChange={(accent) => patch({ accent })}
        />
        <SliderPanel
          mobile
          title="Tint — hue in the greys"
          value={tintLabel(draft)}
          fraction={draft.tint / 0.3}
          current={draft.tint}
          min={0}
          max={0.3}
          step={0.01}
          onChange={(e) => patch({ tint: Number(e.target.value) })}
        />
        <SliderPanel
          mobile
          title="Separation — space between surfaces"
          value={separationLabel(draft)}
          fraction={(draft.separation - 0.5) / 2}
          current={draft.separation}
          min={0.5}
          max={2.5}
          step={0.05}
          onChange={(e) => patch({ separation: Number(e.target.value) })}
        />
        <p className={CAP}>Surfaces — all derived</p>
        <div className="grid grid-cols-7 gap-1.5">
          {swatches.map((s) => (
            <span key={s.key} className="flex flex-col gap-1">
              <span
                className="border-line-hairline h-11 rounded-[7px] border"
                style={{ background: tokens[s.key] }}
              />
              <span className="text-text-disabled font-mono text-[6.5px] uppercase">{s.label}</span>
            </span>
          ))}
        </div>
        <LockedHues size="mobile" />
      </div>
    </PushedScreen>
  )
}
