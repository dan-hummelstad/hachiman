import { useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Copy, Download, KeyRound, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { StepBody, StepFooter, StepFrame } from '@/components/security/screen-window'
import {
  RECOVERY_KEY_CHARS,
  checkRecoveryKey,
  checkRecoveryKeyShape,
  recoveryKeyBody
} from '@/components/security/recovery-key'
import { Callout } from '@/components/ui/callout'

/**
 * Shows a new recovery key one time (§12.11.3). The key lives only in the state of the caller:
 * it is never put in a store. `onDone` runs after the user confirms that the key is saved. It
 * renders a whole dialog step (header, body, footer).
 */
export function RecoveryKeyReveal({
  recoveryKey,
  onDone,
  doneLabel = 'Continue'
}: {
  recoveryKey: string
  onDone: () => void
  doneLabel?: string
}): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const checkId = useId()
  const groups = recoveryKey.split('-')

  const copy = (): void => {
    navigator.clipboard.writeText(recoveryKey).then(
      () => setNote('The key is on the clipboard. Paste it into a safe place, then clear it.'),
      () => setNote('Could not copy. Write the key down by hand.')
    )
  }
  const download = (): void => {
    const text = [
      'Hachiman recovery key',
      '',
      recoveryKey,
      '',
      'Anyone with this key can read all of your encrypted history.',
      'Keep it private. Do not keep it on a shared device.',
      ''
    ].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'hachiman-recovery-key.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <StepFrame
      icon={<KeyRound />}
      feature="event"
      title="Save your recovery key"
      subtitle="Hachiman shows it only this one time"
      footer={
        <Button type="button" disabled={!saved} onClick={onDone}>
          {doneLabel}
        </Button>
      }
    >
      <p>
        This is your recovery key. You need it to use your encrypted messages on a new device when
        no other device is signed in.
      </p>
      <div
        aria-label="Recovery key"
        className="border-line-hairline bg-surface-sunken grid grid-cols-4 gap-x-4 gap-y-1.5 border px-4 py-3 font-mono text-[15px] leading-6 font-semibold tracking-wider select-all"
      >
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          <Copy /> Copy
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={download}>
          <Download /> Download as a text file
        </Button>
      </div>
      {note && <p className="text-meta text-text-tertiary">{note}</p>}
      <Callout tone="danger">
        Anyone with this key can read all of your encrypted history. Keep it private. If you lose it
        and all of your devices, you cannot read your old messages again.
      </Callout>
      <label htmlFor={checkId} className="flex items-start gap-2">
        <Checkbox
          id={checkId}
          className="mt-0.5"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I saved my recovery key in a safe place.
      </label>
    </StepFrame>
  )
}

/**
 * Recovery key input with early typo feedback: the characters, the length and the checksum. The
 * aliases O → 0 and I, L → 1 apply. `onSubmit` gets the canonical text. It renders the body
 * and the footer of a dialog step; `footerStart` goes first in the footer (a Back button).
 */
export function RecoveryKeyInput({
  busy,
  error,
  submitLabel,
  onSubmit,
  footerStart
}: {
  busy: boolean
  error: string | null
  submitLabel: string
  onSubmit: (recoveryKey: string) => void
  footerStart?: React.ReactNode
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [checkError, setCheckError] = useState<string | null>(null)
  const shape = checkRecoveryKeyShape(value)
  const typed = recoveryKeyBody(value).length
  const hint = shape.ok
    ? 'All 55 characters are there.'
    : shape.reason === 'empty'
      ? `55 characters, in groups of 5. Case, spaces and dashes do not matter.`
      : shape.detail

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const result = await checkRecoveryKey(value)
    if (!result.ok) return setCheckError(result.detail)
    setCheckError(null)
    onSubmit(result.text)
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="contents">
      <StepBody>
        <Field id="recovery-key-input" label="Recovery key">
          <Textarea
            id="recovery-key-input"
            className="font-mono text-[15px] font-semibold tracking-wider uppercase"
            placeholder="HRK1-XXXXX-XXXXX-…"
            value={value}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="characters"
            aria-invalid={!shape.ok && shape.reason !== 'empty' && shape.reason !== 'incomplete'}
            aria-describedby="recovery-key-hint"
            onChange={(e) => {
              setValue(e.target.value)
              setCheckError(null)
            }}
          />
        </Field>
        <p id="recovery-key-hint" className="text-meta text-text-tertiary -mt-1.5 flex gap-3">
          <span className="flex-1">{hint}</span>
          <span className="tabular-nums">
            {Math.min(typed, RECOVERY_KEY_CHARS)} / {RECOVERY_KEY_CHARS}
          </span>
        </p>
        <ErrorText>{checkError ?? error}</ErrorText>
      </StepBody>
      <StepFooter>
        {footerStart}
        <Button type="submit" disabled={busy || typed < RECOVERY_KEY_CHARS}>
          <RotateCcw />
          {busy ? 'Checking…' : submitLabel}
        </Button>
      </StepFooter>
    </form>
  )
}
