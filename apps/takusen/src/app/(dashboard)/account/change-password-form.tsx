'use client'

import { useActionState, useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'

import {
  changePasswordAction,
  type AccountActionResult,
} from './actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Updating…' : 'Update password'}
    </Button>
  )
}

export function ChangePasswordForm(): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null)
  const [state, formAction] = useActionState<
    AccountActionResult | undefined,
    FormData
  >(changePasswordAction, undefined)

  useEffect(() => {
    if (state?.ok) {
      if (state.message) {
        toast.success(state.message)
      }
      formRef.current?.reset()
    }
  }, [state])

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-5">
      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Field id="currentPassword" label="Current password">
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <Field id="newPassword" label="New password">
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </Field>
      <Field id="confirmPassword" label="Confirm new password">
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </Field>
      <div className="flex">
        <SubmitButton />
      </div>
    </form>
  )
}
