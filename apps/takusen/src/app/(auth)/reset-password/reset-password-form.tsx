'use client'

import { CircleCheckIcon, InfoIcon, LockKeyholeIcon } from 'lucide-react'
import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { AuthCard } from '@/components/auth-frame'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { PasswordMeter } from '@/components/ui/password-meter'

import { resetPasswordAction, type FormActionResult } from '../actions'
import { CardNote, FormError, IconTile } from '../auth-parts'
import { PASSWORD_MIN_LENGTH } from '@/lib/password-strength'

function SubmitButton({ disabled }: { disabled: boolean }): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full max-sm:h-12" disabled={pending || disabled}>
      {pending ? 'Updating…' : 'Set new password'}
    </Button>
  )
}

export interface ResetPasswordFormProps {
  token: string
  /** The account the link belongs to, named in the lead. */
  email: string
  loginHref: string
}

export function ResetPasswordForm({ token, email, loginHref }: ResetPasswordFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    resetPasswordAction,
    undefined,
  )
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  if (state?.ok) {
    return (
      <AuthCard
        media={<IconTile icon={CircleCheckIcon} />}
        title="Password updated"
        lead={state.message ?? 'Your password has been changed. You can now sign in.'}
      >
        <Button asChild size="lg" className="w-full max-sm:h-12">
          <Link href={loginHref}>Go to sign in</Link>
        </Button>
      </AuthCard>
    )
  }

  const matches = confirm.length > 0 && confirm === password
  // Say "do not match" only once the confirmation is as long as the password, not mid-typing.
  const mismatch = confirm.length >= password.length && confirm.length > 0 && !matches

  return (
    <AuthCard
      media={<IconTile icon={LockKeyholeIcon} />}
      title="Choose a new password"
      lead={`For ${email}. Use at least ${PASSWORD_MIN_LENGTH} characters you don’t use anywhere else.`}
      footer={<CardNote icon={InfoIcon}>This signs you out of every other device.</CardNote>}
    >
      <form action={formAction} className="flex flex-col gap-[22px] max-sm:gap-[18px]">
        {state?.error && <FormError>{state.error}</FormError>}
        <input type="hidden" name="token" value={token} />
        <div className="flex flex-col gap-4 max-sm:gap-3.5">
          <Field id="password" label="New password">
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              aria-describedby="password-meter"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoFocus
            />
            <PasswordMeter id="password-meter" password={password} email={email} common />
          </Field>
          <Field
            id="confirm"
            label="Confirm new password"
            error={mismatch ? 'Passwords do not match.' : undefined}
            hint={
              matches ? <span className="text-feature-voice-text">Passwords match.</span> : undefined
            }
          >
            <Input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              leading={<LockKeyholeIcon aria-hidden />}
              trailing={
                matches ? (
                  <span className="flex text-feature-voice-text">
                    <CircleCheckIcon aria-hidden />
                  </span>
                ) : undefined
              }
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? 'confirm-error' : matches ? 'confirm-hint' : undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
        </div>
        <SubmitButton disabled={!matches} />
      </form>
    </AuthCard>
  )
}
