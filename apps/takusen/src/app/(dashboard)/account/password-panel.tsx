'use client'

import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { startTransition, useActionState, useState } from 'react'

import { PasswordStrengthMeter } from '@/components/account/password-strength-meter'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Panel, PanelFooter, PanelHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { PasswordInput } from '@/components/ui/password-input'

import { changePasswordAction, type AccountActionResult, type AccountField } from './actions'

type PasswordField = Exclude<AccountField, 'displayName'>

const EMPTY: Record<PasswordField, string> = { currentPassword: '', newPassword: '', confirmPassword: '' }

function ErrorLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="flex items-start gap-1.5 text-[12.5px] font-semibold">
      <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      {children}
    </span>
  )
}

/**
 * E2 / E4 Password. The inputs are controlled and the form is submitted by hand, so a wrong
 * current password never clears the new password the user typed.
 */
export function PasswordPanel({ email, changed }: { email: string; changed: string | null }): React.JSX.Element {
  const router = useRouter()
  const [values, setValues] = useState(EMPTY)
  // The field the user edited since the last result: its error is stale.
  const [editedField, setEditedField] = useState<PasswordField | null>(null)
  const [state, formAction, pending] = useActionState<AccountActionResult | undefined, FormData>(
    async (prev, data) => {
      const res = await changePasswordAction(prev, data)
      if (res.ok) {
        setValues(EMPTY)
        router.refresh()
      }
      return res
    },
    undefined,
  )

  const fieldError = (f: PasswordField): string | undefined =>
    state?.field === f && editedField !== f ? state.error : undefined
  const formError = state && !state.ok && !state.field ? state.error : undefined
  const anyFieldError = state?.field !== undefined && editedField !== state.field

  const bind = (f: PasswordField) => ({
    id: f,
    name: f,
    value: values[f],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setValues((v) => ({ ...v, [f]: e.target.value }))
      if (state?.field === f) setEditedField(f)
    },
    'aria-invalid': fieldError(f) ? true : undefined,
    'aria-describedby': fieldError(f) ? `${f}-error` : undefined,
  })

  const confirmMatches = values.confirmPassword !== '' && values.confirmPassword === values.newPassword

  return (
    <Panel>
      <PanelHeader title="Password" meta={changed ?? undefined} />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          setEditedField(null)
          startTransition(() => formAction(data))
        }}
        className="flex flex-1 flex-col"
      >
        <div className="flex flex-1 flex-col gap-[18px] p-5">
          <Field
            id="currentPassword"
            label="Current password"
            error={fieldError('currentPassword') && <ErrorLine>{fieldError('currentPassword')}</ErrorLine>}
          >
            <PasswordInput
              {...bind('currentPassword')}
              autoComplete="current-password"
              required
              trailing={
                fieldError('currentPassword') ? (
                  <CircleAlertIcon aria-hidden className="text-feature-danger-text!" />
                ) : undefined
              }
            />
          </Field>
          <Field
            id="newPassword"
            label="New password"
            error={fieldError('newPassword') && <ErrorLine>{fieldError('newPassword')}</ErrorLine>}
          >
            <PasswordInput {...bind('newPassword')} autoComplete="new-password" required minLength={8} />
            {values.newPassword && (
              <PasswordStrengthMeter password={values.newPassword} email={email} />
            )}
          </Field>
          <Field
            id="confirmPassword"
            label="Confirm new password"
            error={fieldError('confirmPassword') && <ErrorLine>{fieldError('confirmPassword')}</ErrorLine>}
          >
            <PasswordInput
              {...bind('confirmPassword')}
              autoComplete="new-password"
              required
              minLength={8}
              trailing={
                confirmMatches ? (
                  <CircleCheckIcon aria-label="Passwords match" className="text-feature-voice-text!" />
                ) : undefined
              }
            />
          </Field>
          {!anyFieldError && (
            <Alert variant="info" role="note">
              <InfoIcon aria-hidden />
              <AlertDescription>
                Updating your password signs you out of every other device. You stay signed in here.
              </AlertDescription>
            </Alert>
          )}
        </div>
        <PanelFooter className="bg-transparent px-5 py-3">
          <p aria-live="polite" className="min-w-0 flex-1 text-[13px] font-bold">
            {state?.ok && (
              <span className="flex items-center gap-1.5 text-feature-voice-text">
                <CircleCheckIcon aria-hidden className="size-[15px] shrink-0" />
                {state.message}
              </span>
            )}
            {formError && <span className="text-feature-danger-text">{formError}</span>}
          </p>
          <Button type="submit" disabled={pending}>
            {pending ? 'Updating…' : 'Update password'}
          </Button>
        </PanelFooter>
      </form>
    </Panel>
  )
}
