'use client'

import { MailIcon } from 'lucide-react'
import { useActionState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

import { AuthCard } from '@/components/auth-frame'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldLink } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'

import { loginAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full max-sm:h-12" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export interface LoginFormProps {
  next?: string
  lead?: ReactNode
  footer?: ReactNode
}

export function LoginForm({ next, lead, footer }: LoginFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    loginAction,
    undefined,
  )

  return (
    <AuthCard title="Sign in to Takusen" lead={lead} footer={footer}>
      <form action={formAction} className="flex flex-col gap-[22px] max-sm:gap-[18px]">
        {state?.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        {next && <input type="hidden" name="next" value={next} />}
        <div className="flex flex-col gap-4 max-sm:gap-3.5">
          <Field id="email" label="Email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              leading={<MailIcon aria-hidden />}
              required
            />
          </Field>
          <Field
            id="password"
            label="Password"
            aside={<FieldLink href="/forgot-password">Forgot password?</FieldLink>}
          >
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </Field>
        </div>
        <SubmitButton />
      </form>
    </AuthCard>
  )
}
