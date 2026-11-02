import { useEffect, useId, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Keycap } from '@/components/ui/keycap'
import { Switch } from '@/components/ui/switch'
import { useKeybindRuntime, useKeybinds } from '@/hooks/use-keybinds'
import {
  FIXED_KEYBINDS,
  KEYBINDS,
  actionsFor,
  comboOf,
  formatCombo,
  reservedBy,
  toAccelerator,
  type KeybindAction,
  type KeybindSpec,
  type Keybinds
} from '@/lib/keybinds'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

const GROUPS = ['Navigation', 'Voice'] as const
/** Row actions show on hover and on keyboard focus. */
const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'
const LABEL = new Map(KEYBINDS.map((k) => [k.id, k.label]))

/** User settings → Keybinds: rebind the app keys, with a recorder, reset and a conflict warning. */
export function KeybindsSection(): React.JSX.Element {
  const binds = useKeybinds()
  const overrides = usePrefsStore((s) => s.keybinds)
  const resetKeybind = usePrefsStore((s) => s.resetKeybind)
  const desktop = usePlatform().platform === 'electron'
  const [recording, setRecording] = useState<KeybindAction | null>(null)

  // No keybind acts while a combo is recorded, and the global ones are let go (use-global-shortcuts).
  useEffect(() => {
    useKeybindRuntime.setState({ recording: recording !== null })
    return () => useKeybindRuntime.setState({ recording: false })
  }, [recording])

  return (
    <div className="grid gap-x-[30px] gap-y-[22px] xl:grid-cols-2">
      {GROUPS.map((group) => (
        <section key={group}>
          <h3 className="cap mb-[9px]">{group}</h3>
          <div>
            {KEYBINDS.filter((k) => k.group === group).map((k) => (
              <KeybindRow
                key={k.id}
                spec={k}
                binds={binds}
                recording={recording === k.id}
                onRecord={(on) => setRecording(on ? k.id : null)}
              />
            ))}
          </div>
          {group === 'Voice' && (
            <p className="text-text-tertiary mt-2 text-[12px]">
              Push to talk works only while the Hachiman window is focused. Turn it on in Voice and
              audio.
            </p>
          )}
        </section>
      ))}
      {desktop && <GlobalKeybinds binds={binds} />}
      <section className="xl:col-span-2">
        <h3 className="cap mb-[9px]">Fixed keys</h3>
        <div className="grid gap-x-[30px] xl:grid-cols-2">
          {FIXED_KEYBINDS.map((f) => (
            <div key={f.label} className="flex h-[30px] items-center gap-[9px]">
              <span className="text-text-secondary flex-1 text-[12.5px]">{f.label}</span>
              <Keycap>
                {formatCombo(f.combos[0])}
                {f.combos.length > 1 && ` … ${formatCombo(f.combos[f.combos.length - 1])}`}
              </Keycap>
            </div>
          ))}
        </div>
      </section>
      {Object.keys(overrides).length > 0 && (
        <div className="xl:col-span-2">
          <Button variant="quiet" size="sm" onClick={() => resetKeybind()}>
            <RotateCcw />
            Reset all to default
          </Button>
        </div>
      )}
    </div>
  )
}

function KeybindRow({
  spec,
  binds,
  recording,
  onRecord
}: {
  spec: KeybindSpec
  binds: Keybinds
  recording: boolean
  onRecord: (on: boolean) => void
}): React.JSX.Element {
  const setKeybind = usePrefsStore((s) => s.setKeybind)
  const resetKeybind = usePrefsStore((s) => s.resetKeybind)
  const [error, setError] = useState<string | null>(null)
  const combo = binds[spec.id]
  const others = combo ? actionsFor(combo, binds).filter((a) => a !== spec.id) : []
  const changed = combo !== spec.default

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!recording) return
    // The press is the new key, not a shortcut or a focus move.
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return onRecord(false)
    const next = comboOf(e.nativeEvent)
    if (!next) return // a modifier on its own: wait for the key
    const reserved = reservedBy(next)
    if (reserved) return setError(`${formatCombo(next)} is fixed: ${reserved}.`)
    setError(null)
    setKeybind(spec.id, next)
    onRecord(false)
  }

  return (
    <div className="group grid gap-1">
      <div className="flex h-[30px] items-center gap-[9px]">
        <span className="text-text-secondary flex-1 text-[12.5px]">{spec.label}</span>
        <button
          type="button"
          onClick={() => {
            setError(null)
            onRecord(!recording)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => recording && onRecord(false)}
          aria-label={`${spec.label}: ${combo ? formatCombo(combo) : 'no key'}. Press to change.`}
          className={cn(
            'border-line-strong hover:text-text-primary hover:border-text-disabled focus-visible:outline-line-focus inline-flex h-auto min-w-0 items-center rounded-[4px] border px-[5px] py-[3px] font-mono text-[10px] leading-none outline-none focus-visible:outline-2',
            recording
              ? 'border-text-primary text-text-primary'
              : combo
                ? 'text-text-tertiary'
                : 'text-text-disabled'
          )}
        >
          {recording ? 'Press keys…' : combo ? formatCombo(combo) : 'Not set'}
        </button>
        <IconButton
          label="Remove key"
          size="sm"
          className={REVEAL}
          disabled={combo === null}
          onClick={() => setKeybind(spec.id, null)}
        >
          <X />
        </IconButton>
        <IconButton
          label="Reset to default"
          size="sm"
          className={REVEAL}
          disabled={!changed}
          onClick={() => resetKeybind(spec.id)}
        >
          <RotateCcw />
        </IconButton>
      </div>
      {others.length > 0 && (
        <p className="text-you-text text-[12px]">
          Also used by {others.map((a) => LABEL.get(a)).join(', ')}. Only the first one acts.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

/** Desktop: the global switch, and the keys that cannot be global or that another app holds. */
function GlobalKeybinds({ binds }: { binds: Keybinds }): React.JSX.Element {
  const id = useId()
  const on = usePrefsStore((s) => s.globalKeybinds)
  const setOn = usePrefsStore((s) => s.setGlobalKeybinds)
  const failed = useKeybindRuntime((s) => s.globalFailed)
  const global = KEYBINDS.filter((k) => k.global)
  const local = global.filter((k) => {
    const combo = binds[k.id]
    return combo !== null && !toAccelerator(combo)
  })
  return (
    <section className="grid gap-3 xl:col-span-2">
      <h3 className="cap">In the background</h3>
      <div className="flex items-center gap-3">
        <Switch id={id} checked={on} onCheckedChange={setOn} />
        <label htmlFor={id} className="text-text-primary cursor-pointer text-[13px]">
          The mute and deafen keys also work while Hachiman is in the background
        </label>
      </div>
      {on && local.length > 0 && (
        <Callout tone="info">
          {local.map((k) => k.label).join(', ')}: this key works only in the Hachiman window.
        </Callout>
      )}
      {on && failed.length > 0 && (
        <Callout tone="caution">
          Another app holds the key for {failed.map((a) => LABEL.get(a)).join(', ')}. It works only
          in the Hachiman window. Pick another key, or free it in the other app.
        </Callout>
      )}
    </section>
  )
}
