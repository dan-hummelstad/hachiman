'use client'

import Link from 'next/link'
import { useActionState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

import { Window } from '@/components/window'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { loginAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export interface LoginFormProps {
  next?: string
  footer?: ReactNode
}

export function LoginForm({ next, footer }: LoginFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    loginAction,
    undefined,
  )

  return (
    <Window title="Sign in to Takusen" footer={footer}>
      <p className="text-sm text-muted-foreground">Use your Takusen email and password.</p>
      <form action={formAction} className="flex flex-col gap-4">
        {state?.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        {next && <input type="hidden" name="next" value={next} />}
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field
          id="password"
          label="Password"
          aside={
            <Link
              href="/forgot-password"
              className="text-xs leading-4 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Forgot password?
            </Link>
          }
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <SubmitButton />
      </form>
    </Window>
  )
}
