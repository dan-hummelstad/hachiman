'use client'

import Link from 'next/link'
import { useActionState, useEffect } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Window } from '@/components/window'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { resetPasswordAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Updating…' : 'Set new password'}
    </Button>
  )
}

export interface ResetPasswordFormProps {
  token: string
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    resetPasswordAction,
    undefined,
  )

  useEffect(() => {
    if (state?.ok && state.message) {
      toast.success('Password updated', { description: state.message })
    }
  }, [state])

  if (state?.ok) {
    return (
      <Window title="Password updated">
        <p className="text-sm text-muted-foreground">
          {state.message ?? 'Your password has been changed. You can now sign in.'}
        </p>
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </Window>
    )
  }

  return (
    <Window title="Choose a new password">
      <p className="text-sm text-muted-foreground">Pick something at least 8 characters long.</p>
      <form action={formAction} className="flex flex-col gap-4">
        {state?.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <input type="hidden" name="token" value={token} />
        <Field id="password" label="New password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </Field>
        <SubmitButton />
      </form>
    </Window>
  )
}
