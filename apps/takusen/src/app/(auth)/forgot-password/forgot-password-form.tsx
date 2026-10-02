'use client'

import { useActionState, useEffect, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Window } from '@/components/window'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { requestPasswordResetAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  )
}

export function ForgotPasswordForm({ footer }: { footer?: ReactNode }): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    requestPasswordResetAction,
    undefined,
  )

  // Surface the generic confirmation as a toast (anti-enumeration).
  useEffect(() => {
    if (state?.ok && state.message) {
      toast.success('Check your inbox', { description: state.message })
    }
  }, [state])

  return (
    <Window title="Reset your password" footer={footer}>
      <p className="text-sm text-muted-foreground">
        Enter your email and we&apos;ll send a link to set a new password.
      </p>
      <form action={formAction} className="flex flex-col gap-4">
        {state?.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        {state?.ok && state.message && (
          <Alert>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <SubmitButton />
      </form>
    </Window>
  )
}
