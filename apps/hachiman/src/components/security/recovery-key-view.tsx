import { useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Check, Copy, Download, KeyRound, OctagonAlert, RotateCcw } from 'lucide-react'
import { MobileField } from '@/components/mobile/field'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { StepBody, StepFooter, StepFrame, StepHeader } from '@/components/security/screen-window'
import {
  RECOVERY_KEY_CHARS,
  checkRecoveryKey,
  recoveryKeyHint
} from '@/components/security/recovery-key'
import { Callout } from '@/components/ui/callout'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'

/** The desktop dialog form, or the mobile kit form (M18, M19). */
type ViewSize = 'default' | 'touch'

const RECOVERY_KEY_FILE = 'hachiman-recovery-key.txt'

function recoveryKeyFileText(recoveryKey: string): string {
  return [
    'Hachiman recovery key',
    '',
    recoveryKey,
    '',
    'Anyone with this key can read all of your encrypted history.',
    'Keep it private. Do not keep it on a shared device.',
    ''
  ].join('\n')
}

function downloadTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * The recovery key in its groups of 5, four groups to a row, in mono. `size="touch"` is the M19
 * key block: 18 px, the groups spread over the row.
 */
export function RecoveryKeyBlock({
  recoveryKey,
  size = 'default'
}: {
  recoveryKey: string
  size?: ViewSize
}): React.JSX.Element {
  return (
    <div
      aria-label="Recovery key"
      className={cn(
        'border-line-hairline bg-surface-sunken grid grid-cols-4 gap-x-4 gap-y-1.5 border px-4 py-3 font-mono text-[15px] leading-6 font-semibold tracking-wider select-all',
        size === 'touch' &&
          'grid-cols-[repeat(4,auto)] justify-between gap-x-2 gap-y-2 px-[18px] py-4 text-[18px] tracking-[1px]'
      )}
    >
      {recoveryKey.split('-').map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </div>
  )
}

/**
 * Copy and save of the recovery key, and the note on the result. Save uses the host's
 * `saveTextFile` (iOS: the Files export sheet) when it has one, else a text file download.
 */
export function RecoveryKeyActions({
  recoveryKey,
  size = 'default'
}: {
  recoveryKey: string
  size?: ViewSize
}): React.JSX.Element {
  const platform = usePlatform()
  const [note, setNote] = useState<string | null>(null)
  const touch = size === 'touch'
  const saveTextFile = platform.saveTextFile

  const copy = (): void => {
    navigator.clipboard.writeText(recoveryKey).then(
      () => setNote('The key is on the clipboard. Paste it into a safe place, then clear it.'),
      () => setNote('Could not copy. Write the key down by hand.')
    )
  }
  const save = (): void => {
    const text = recoveryKeyFileText(recoveryKey)
    if (!saveTextFile) return downloadTextFile(RECOVERY_KEY_FILE, text)
    saveTextFile(RECOVERY_KEY_FILE, text).then(
      (saved) => {
        if (saved) setNote('The file is saved. Keep it somewhere safe and offline.')
      },
      () => setNote('Could not save the file. Copy the key, or write it down by hand.')
    )
  }

  return (
    <>
      <div className={touch ? 'grid grid-cols-2 gap-2.5' : 'flex flex-wrap gap-2'}>
        <Button type="button" variant="secondary" size={touch ? 'mobile' : 'sm'} onClick={copy}>
          <Copy /> Copy
        </Button>
        <Button type="button" variant="secondary" size={touch ? 'mobile' : 'sm'} onClick={save}>
          <Download />
          {saveTextFile ? 'Save to Files' : touch ? 'Download' : 'Download as a text file'}
        </Button>
      </div>
      {note && (
        <p
          className={
            touch ? 'text-text-tertiary text-[13px] font-medium' : 'text-meta text-text-tertiary'
          }
        >
          {note}
        </p>
      )}
    </>
  )
}

/**
 * Shows a new recovery key one time (§12.11.3). The key lives only in the state of the caller:
 * it is never put in a store. `onDone` runs after the user confirms that the key is saved. It
 * renders a whole dialog step (header, body, footer). `size="touch"` is the step in a mobile
 * sheet (M27): the key in the 4-column mono grid, 48 Copy and Save, one red line, and the 36
 * confirm row docked with the button at the sheet foot.
 */
export function RecoveryKeyReveal({
  recoveryKey,
  onDone,
  doneLabel = 'Continue',
  size = 'default'
}: {
  recoveryKey: string
  onDone: () => void
  doneLabel?: string
  size?: ViewSize
}): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const checkId = useId()

  if (size === 'touch') {
    return (
      <>
        <StepHeader
          icon={<KeyRound />}
          feature="event"
          title="Save your recovery key"
          subtitle="Hachiman shows it only this one time"
        />
        <div className="flex flex-col gap-4">
          <p className="text-text-secondary text-[14.5px] leading-[1.5] font-medium">
            This is your recovery key. You need it to use your encrypted messages on a new device
            when no other device is signed in.
          </p>
          <RecoveryKeyBlock recoveryKey={recoveryKey} size="touch" />
          <RecoveryKeyActions recoveryKey={recoveryKey} size="touch" />
          <p className="text-feature-danger-text flex items-start gap-2.5 text-[13.5px] leading-[1.45] font-semibold">
            <OctagonAlert aria-hidden className="mt-px size-[17px] shrink-0" />
            Anyone with this key can read all of your encrypted history. Keep it private and
            offline.
          </p>
        </div>
        <StepFooter>
          <label
            htmlFor={checkId}
            className="text-text-primary flex min-h-9 items-center gap-3 px-0.5 text-[14.5px] leading-[1.4] font-semibold"
          >
            <Checkbox
              id={checkId}
              size="lg"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            I saved my recovery key somewhere safe.
          </label>
          <Button type="button" disabled={!saved} onClick={onDone}>
            <Check />
            {doneLabel}
          </Button>
        </StepFooter>
      </>
    )
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
      <RecoveryKeyBlock recoveryKey={recoveryKey} />
      <RecoveryKeyActions recoveryKey={recoveryKey} />
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
 * `size="touch"` is the M18 field: mono 17, three rows, the count beside the helper, and the
 * keyboard's "done" key submits a complete key (else it closes the keyboard).
 */
export function RecoveryKeyInput({
  busy,
  error,
  submitLabel,
  onSubmit,
  footerStart,
  size = 'default'
}: {
  busy: boolean
  error: string | null
  submitLabel: string
  onSubmit: (recoveryKey: string) => void
  footerStart?: React.ReactNode
  size?: ViewSize
}): React.JSX.Element {
  const platform = usePlatform()
  const [value, setValue] = useState('')
  const [checkError, setCheckError] = useState<string | null>(null)
  const touch = size === 'touch'
  const hint = recoveryKeyHint(value, size)
  const shownError = checkError ?? error

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const result = await checkRecoveryKey(value)
    if (!result.ok) {
      platform.haptic('warning')
      return setCheckError(result.detail)
    }
    setCheckError(null)
    onSubmit(result.text)
  }
  const change = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setValue(e.target.value)
    setCheckError(null)
  }
  const submitButton = (
    <Button type="submit" size={touch ? 'mobile' : 'default'} disabled={busy || !hint.ready}>
      <RotateCcw />
      {busy ? 'Checking…' : submitLabel}
    </Button>
  )

  if (touch) {
    return (
      <form onSubmit={(e) => void submit(e)} className="contents">
        <StepBody>
          <MobileField
            id="recovery-key-input"
            label="Recovery key"
            hint={
              <span className="flex items-start gap-3">
                <span className={cn('flex-1', hint.invalid && 'text-feature-danger-text')}>
                  {hint.text}
                </span>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 font-bold tabular-nums',
                    hint.complete && 'text-feature-voice-text'
                  )}
                >
                  {hint.complete && <Check aria-hidden className="size-[13px]" />}
                  {hint.count} / {RECOVERY_KEY_CHARS}
                </span>
              </span>
            }
          >
            <Textarea
              size="touch"
              rows={3}
              className="min-h-[106px] font-mono text-[17px]! leading-[1.6] font-semibold tracking-[0.5px] uppercase"
              placeholder="HRK1-XXXXX-XXXXX-…"
              value={value}
              spellCheck={false}
              autoCorrect="off"
              autoComplete="off"
              autoCapitalize="characters"
              enterKeyHint="done"
              aria-invalid={hint.invalid || shownError !== null || undefined}
              aria-describedby={
                shownError
                  ? 'recovery-key-input-hint recovery-key-error'
                  : 'recovery-key-input-hint'
              }
              onChange={change}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                e.preventDefault()
                if (hint.ready && !busy) e.currentTarget.form?.requestSubmit()
                else e.currentTarget.blur()
              }}
            />
          </MobileField>
          {shownError && (
            <p
              id="recovery-key-error"
              role="alert"
              className="text-feature-danger-text text-[13px] leading-[1.4] font-semibold"
            >
              {shownError}
            </p>
          )}
        </StepBody>
        <StepFooter>
          {footerStart}
          {submitButton}
        </StepFooter>
      </form>
    )
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
            aria-invalid={hint.invalid}
            aria-describedby="recovery-key-hint"
            onChange={change}
          />
        </Field>
        <p id="recovery-key-hint" className="text-meta text-text-tertiary -mt-1.5 flex gap-3">
          <span className="flex-1">{hint.text}</span>
          <span className="tabular-nums">
            {hint.count} / {RECOVERY_KEY_CHARS}
          </span>
        </p>
        <ErrorText>{shownError}</ErrorText>
      </StepBody>
      <StepFooter>
        {footerStart}
        {submitButton}
      </StepFooter>
    </form>
  )
}
