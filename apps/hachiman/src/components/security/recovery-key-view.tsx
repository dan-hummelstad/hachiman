import { useId, useState } from 'react'
import { Copy, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Warning } from '@/components/security/screen-window'
import {
  RECOVERY_KEY_CHARS,
  checkRecoveryKey,
  checkRecoveryKeyShape,
  recoveryKeyBody
} from '@/components/security/recovery-key'

/**
 * Shows a new recovery key one time (§12.11.3). The key lives only in the state of the caller:
 * it is never put in a store. `onDone` runs after the user confirms that the key is saved.
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
    <div className="grid gap-4">
      <p className="text-sm">
        This is your recovery key. You need it to use your encrypted messages on a new device when
        no other device is signed in. Hachiman shows it only this one time.
      </p>
      <div
        aria-label="Recovery key"
        className="bg-card grid grid-cols-4 gap-x-3 gap-y-1 border p-3 font-mono text-[15px] leading-6 tracking-wider select-all"
      >
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy /> Copy
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download /> Download as a text file
        </Button>
      </div>
      {note && <p className="text-muted-foreground text-xs leading-4">{note}</p>}
      <Warning tone="danger">
        Anyone with this key can read all of your encrypted history. Keep it private. If you lose it
        and all of your devices, you cannot read your old messages again.
      </Warning>
      <label htmlFor={checkId} className="flex items-start gap-2 text-sm">
        <input
          id={checkId}
          type="checkbox"
          className="accent-primary mt-0.5 size-4"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I saved my recovery key in a safe place.
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  )
}

/**
 * Recovery key input with early typo feedback: the characters, the length and the checksum. The
 * aliases O → 0 and I, L → 1 apply. `onSubmit` gets the canonical text.
 */
export function RecoveryKeyInput({
  busy,
  error,
  submitLabel,
  onSubmit
}: {
  busy: boolean
  error: string | null
  submitLabel: string
  onSubmit: (recoveryKey: string) => void
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
    <form onSubmit={(e) => void submit(e)} className="grid gap-3">
      <Field id="recovery-key-input" label="Recovery key" hint={hint}>
        <Textarea
          id="recovery-key-input"
          className="font-mono text-[14px] tracking-wider uppercase"
          placeholder="HRK1-XXXXX-XXXXX-…"
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          aria-invalid={!shape.ok && shape.reason !== 'empty' && shape.reason !== 'incomplete'}
          onChange={(e) => {
            setValue(e.target.value)
            setCheckError(null)
          }}
        />
      </Field>
      <ErrorText>{checkError ?? error}</ErrorText>
      <Button type="submit" disabled={busy || typed < RECOVERY_KEY_CHARS}>
        {busy ? 'Checking…' : submitLabel}
      </Button>
    </form>
  )
}
