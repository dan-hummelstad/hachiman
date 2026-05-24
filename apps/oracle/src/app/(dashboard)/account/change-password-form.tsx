'use client'

import { useActionState, useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>
      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  )
}
