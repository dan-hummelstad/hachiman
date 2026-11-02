import { useState } from 'react'
import { Check, Copy, Download, EyeOff, KeyRound, TriangleAlert } from 'lucide-react'
import { MobileField } from '@/components/mobile/field'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  LiveDots,
  StepBody,
  StepFooter,
  StepFrame,
  StepHeader
} from '@/components/security/screen-window'
import {
  RECOVERY_KEY_CHARS,
  checkRecoveryKey,
  recoveryKeyBody,
  recoveryKeyHint
} from '@/components/security/recovery-key'
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
 * The recovery key as numbered groups: `HRK1` and 11 groups of 5, 12 cells in all, mono. The
 * index is decoration (`aria-hidden`); the text of a group is selectable. `size="touch"` is the
 * mobile form: two columns of bordered cells.
 */
export function RecoveryKeyBlock({
  recoveryKey,
  size = 'default'
}: {
  recoveryKey: string
  size?: ViewSize
}): React.JSX.Element {
  const touch = size === 'touch'
  return (
    <div
      aria-label="Recovery key"
      className={cn(
        'border-line-hairline bg-surface-sunken grid border',
        touch
          ? 'grid-cols-2 gap-2.5 rounded-[14px] p-4'
          : 'rounded-control grid-cols-3 gap-x-2.5 gap-y-[11px] px-3.5 py-[15px]'
      )}
    >
      {recoveryKey.split('-').map((g, i) => (
        <span
          key={i}
          className={cn(
            touch
              ? 'border-line-hairline bg-surface-panel flex h-[46px] items-center gap-[9px] rounded-[10px] border px-[13px]'
              : 'flex items-baseline gap-[7px]'
          )}
        >
          <span
            aria-hidden
            className={cn(
              'text-text-disabled font-mono select-none',
              touch ? 'text-[9.5px]' : 'text-[8.5px] tracking-[0.6px]'
            )}
          >
            {String(i + 1).padStart(2, '0')}
          </span>
          <span
            className={cn(
              'text-text-primary font-mono select-all',
              touch ? 'text-[14.5px] font-medium' : 'text-[13px] tracking-[0.2px]'
            )}
          >
            {g}
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * Copy and save of the recovery key, and the note on the result. Save uses the host's
 * `saveTextFile` (iOS: the Files export sheet) when it has one, else a text file download.
 */
function useRecoveryKeyActions(recoveryKey: string): {
  copy: () => void
  save: () => void
  note: string | null
  saveTextFile: boolean
} {
  const platform = usePlatform()
  const [note, setNote] = useState<string | null>(null)
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
  return { copy, save, note, saveTextFile: saveTextFile !== null }
}

export function RecoveryKeyActions({
  recoveryKey,
  size = 'default'
}: {
  recoveryKey: string
  size?: ViewSize
}): React.JSX.Element {
  const { copy, save, note, saveTextFile } = useRecoveryKeyActions(recoveryKey)
  const touch = size === 'touch'

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
            touch ? 'text-text-tertiary text-[13px]' : 'text-text-tertiary text-[12px]'
          }
        >
          {note}
        </p>
      )}
    </>
  )
}

/** The three groups that the confirm step asks for (1-based 03, 07, 11 of the 12 cells). */
const CONFIRM_CELLS = [2, 6, 10] as const

/**
 * Shows a new recovery key one time (§12.11.3). The key lives only in the state of the caller:
 * it is never put in a store. `onDone` runs after the user saved the key. Desktop: step 1 reveals
 * the key, step 2 asks for three of its groups back (compared here, nothing is sent). Touch is
 * the one-step sheet (F1, M27): the key, one caution, and "I have written it down".
 */
export function RecoveryKeyReveal({
  recoveryKey,
  onDone,
  doneLabel = 'Continue',
  size = 'default'
}: {
  recoveryKey: string
  onDone: () => void
  /** Labels the confirm button of the desktop second step. */
  doneLabel?: string
  size?: ViewSize
}): React.JSX.Element {
  const [phase, setPhase] = useState<'reveal' | 'confirm'>('reveal')
  const actions = useRecoveryKeyActions(recoveryKey)

  if (size === 'touch') {
    return (
      <>
        <StepHeader icon={<KeyRound />} feature="event" title="Recovery key" />
        <div className="flex flex-col gap-4">
          <h2 className="text-text-primary text-[22px] leading-[1.2] font-semibold tracking-[-0.5px]">
            Write this key down
          </h2>
          <p className="text-text-tertiary text-[13px] leading-[1.45]">
            It is the only way back into your messages if you lose every device. Hachiman does not
            keep a copy.
          </p>
          <RecoveryKeyBlock recoveryKey={recoveryKey} size="touch" />
          <p className="border-you/40 flex gap-2.5 rounded-[12px] border px-3.5 py-3">
            <EyeOff aria-hidden className="text-you-text size-4 shrink-0" />
            <span className="text-you-text text-[11.5px] leading-[1.4]">
              This is the last time the key is shown. Anyone holding it can read your messages.
            </span>
          </p>
          {actions.note && <p className="text-text-tertiary text-[13px]">{actions.note}</p>}
        </div>
        <StepFooter>
          <Button type="button" size="mobile" onClick={onDone}>
            I have written it down
          </Button>
          <Button type="button" variant="secondary" size="mobile" onClick={actions.copy}>
            <Copy /> Copy to clipboard
          </Button>
          {actions.saveTextFile && (
            <Button type="button" variant="quiet" size="mobile" onClick={actions.save}>
              <Download /> Save to Files
            </Button>
          )}
        </StepFooter>
      </>
    )
  }

  if (phase === 'confirm') {
    return (
      <ConfirmKeyStep
        recoveryKey={recoveryKey}
        doneLabel={doneLabel}
        onBack={() => setPhase('reveal')}
        onDone={onDone}
      />
    )
  }

  return (
    <StepFrame
      icon={<KeyRound />}
      feature="event"
      title="This is shown once"
      subtitle="Step 1 of 2 · Reveal"
      footer={
        <>
          <Button type="button" variant="secondary" className="flex-1" onClick={actions.copy}>
            <Copy /> Copy
          </Button>
          <Button type="button" variant="quiet" onClick={actions.save}>
            <Download /> {actions.saveTextFile ? 'Save to Files' : 'Download'}
          </Button>
          <Button type="button" className="flex-1" onClick={() => setPhase('confirm')}>
            I have saved it
          </Button>
        </>
      }
    >
      <p>
        Write it down, or put it in a password manager. Hachiman keeps no copy and will never show
        it to you again.
      </p>
      <RecoveryKeyBlock recoveryKey={recoveryKey} />
      {actions.note && <p className="text-text-tertiary text-[12px]">{actions.note}</p>}
      <p className="border-you flex items-center gap-[9px] border py-[9px] pr-3 pl-[11px]">
        <TriangleAlert aria-hidden className="text-you size-3.5 shrink-0" />
        <span className="text-you-text font-mono text-[9px] leading-[1.4] font-semibold tracking-[1px] uppercase">
          Anyone with this key can read all of your history. Lose it and all your devices, and
          nobody can get you back in.
        </span>
      </p>
    </StepFrame>
  )
}

/** Step 2 of the desktop reveal: type three groups back. Checked here, never sent. */
function ConfirmKeyStep({
  recoveryKey,
  doneLabel,
  onBack,
  onDone
}: {
  recoveryKey: string
  doneLabel: string
  onBack: () => void
  onDone: () => void
}): React.JSX.Element {
  const groups = recoveryKey.split('-')
  const [values, setValues] = useState<string[]>(() => CONFIRM_CELLS.map(() => ''))
  const matched = CONFIRM_CELLS.map(
    (cell, i) => values[i] !== '' && recoveryKeyBody(values[i]) === recoveryKeyBody(groups[cell])
  )
  const count = matched.filter(Boolean).length
  const firstEmpty = values.findIndex((v) => v === '')

  return (
    <StepFrame
      icon={<KeyRound />}
      feature="event"
      title="Type three of them back"
      subtitle="Step 2 of 2 · Confirm"
      footer={
        <>
          <Button type="button" variant="quiet" className="flex-1" onClick={onBack}>
            Back
          </Button>
          <Button type="button" className="flex-1" disabled={count < 3} onClick={onDone}>
            {doneLabel}
          </Button>
        </>
      }
    >
      <p>So we can tell it actually got written down somewhere, and not just looked at.</p>
      <div className="grid grid-cols-3 gap-2.5">
        {CONFIRM_CELLS.map((cell, i) => {
          const id = `recovery-confirm-${cell}`
          const wrong = values[i] !== '' && !matched[i]
          return (
            <div key={cell} className="grid gap-1.5">
              <label
                htmlFor={id}
                className="text-text-disabled font-mono text-[8.5px] tracking-[1.1px]"
              >
                GROUP {String(cell + 1).padStart(2, '0')}
              </label>
              <Input
                id={id}
                className={cn(
                  'h-10 font-mono text-[13.5px] uppercase',
                  (wrong || i === firstEmpty) && 'border-you'
                )}
                value={values[i]}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="characters"
                aria-invalid={wrong || undefined}
                onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-[9px]" role="status">
        {count > 0 && count < 3 && (
          <>
            <LiveDots />
            <span className="text-live-text font-mono text-[9.5px] font-semibold tracking-[1.1px]">
              CHECKING AGAINST YOUR KEY
            </span>
          </>
        )}
        <span className="flex-1" />
        <span className="text-text-disabled font-mono text-[9px] tracking-[0.9px]">
          {count} OF 3 MATCHED
        </span>
      </div>
      <div className="bg-line-hairline h-px" />
      <p className="text-[12px]">Cannot find a group? Go back and read the key again.</p>
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
      <KeyRound />
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
                <span className={cn('flex-1', hint.invalid && 'text-you-text')}>
                  {hint.text}
                </span>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 font-semibold tabular-nums',
                    hint.complete && 'text-text-primary'
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
              className="text-you-text text-[13px] leading-[1.4] font-semibold"
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
            className="font-mono text-[13.5px] tracking-[0.5px] uppercase"
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
        <p id="recovery-key-hint" className="text-text-tertiary -mt-1.5 flex gap-3 text-[12px]">
          <span className="flex-1">{hint.text}</span>
          <span className="font-mono text-[10px] tabular-nums">
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
