import { useEffect, useId, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ErrorText, SectionHeading } from '@/components/ui/field'
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
    <div className="grid gap-8">
      {GROUPS.map((group) => (
        <section key={group}>
          <SectionHeading>{group}</SectionHeading>
          <div className="border-line-hairline divide-line-hairline divide-y border">
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
            <p className="text-meta text-text-tertiary mt-2">
              Push to talk works only while the Hachiman window is focused. Turn it on in Voice and
              audio.
            </p>
          )}
        </section>
      ))}
      {desktop && <GlobalKeybinds binds={binds} />}
      <section>
        <SectionHeading>Fixed keys</SectionHeading>
        <div className="border-line-hairline divide-line-hairline divide-y border">
          {FIXED_KEYBINDS.map((f) => (
            <div key={f.label} className="flex min-h-11 items-center gap-3 px-3.5 py-2">
              <span className="text-label flex-1">{f.label}</span>
              <Keycap>
                {formatCombo(f.combos[0])}
                {f.combos.length > 1 && ` … ${formatCombo(f.combos[f.combos.length - 1])}`}
              </Keycap>
            </div>
          ))}
        </div>
      </section>
      {Object.keys(overrides).length > 0 && (
        <div>
          <Button variant="secondary" onClick={() => resetKeybind()}>
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
    <div className="grid gap-1 px-3.5 py-2">
      <div className="flex min-h-7 items-center gap-2">
        <span className="text-label flex-1">{spec.label}</span>
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
            'rounded-control border-line-hairline inline-flex h-7 min-w-28 items-center justify-center border px-2 font-mono text-[12px] outline-none focus-visible:outline-2 focus-visible:outline-line-focus',
            recording
              ? 'border-accent-primary text-accent-text'
              : combo
                ? 'text-text-primary hover:bg-surface-hover'
                : 'text-text-tertiary hover:bg-surface-hover'
          )}
        >
          {recording ? 'Press keys…' : combo ? formatCombo(combo) : 'Not set'}
        </button>
        <IconButton
          label="Remove key"
          size="sm"
          disabled={combo === null}
          onClick={() => setKeybind(spec.id, null)}
        >
          <X />
        </IconButton>
        <IconButton
          label="Reset to default"
          size="sm"
          disabled={!changed}
          onClick={() => resetKeybind(spec.id)}
        >
          <RotateCcw />
        </IconButton>
      </div>
      {others.length > 0 && (
        <p className="text-meta text-feature-event-text">
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
    <section className="grid gap-3">
      <SectionHeading className="mb-0">In the background</SectionHeading>
      <div className="flex items-center gap-3">
        <Switch id={id} checked={on} onCheckedChange={setOn} />
        <label htmlFor={id} className="text-label cursor-pointer">
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
