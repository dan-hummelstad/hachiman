'use client'

import { useActionState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

import { Window } from '@/components/window'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { signupAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Creating account…' : 'Create account'}
    </Button>
  )
}

export function SignupForm({ footer }: { footer?: ReactNode }): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    signupAction,
    undefined,
  )

  return (
    <Window title="Create your Takusen account" footer={footer}>
      <p className="text-sm text-muted-foreground">One account for every Hachiman guild.</p>
      <form action={formAction} className="flex flex-col gap-4">
        {state?.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <Field id="displayName" label="Display name">
          <Input
            id="displayName"
            name="displayName"
            type="text"
            autoComplete="nickname"
            required
            maxLength={64}
          />
        </Field>
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field id="password" label="Password" hint="At least 8 characters.">
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
