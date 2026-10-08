'use client'

import { MailIcon } from 'lucide-react'
import { useActionState, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

import { AuthCard } from '@/components/auth-frame'
import { Button } from '@/components/ui/button'
import { Field, FieldLink } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'

import { loginAction, type FormActionResult } from '../actions'
import { FormError } from '../auth-parts'

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
  forgotHref: string
  lead?: ReactNode
  footer?: ReactNode
}

export function LoginForm({ next, forgotHref, lead, footer }: LoginFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    loginAction,
    undefined,
  )
  // Controlled, so a wrong password does not also clear the address (React resets form fields).
  const [email, setEmail] = useState('')

  return (
    <AuthCard title="Sign in to Takusen" lead={lead} footer={footer}>
      <form action={formAction} className="flex flex-col gap-[22px] max-sm:gap-[18px]">
        {state?.error && <FormError>{state.error}</FormError>}
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field
            id="password"
            label="Password"
            aside={<FieldLink href={forgotHref}>Forgot password?</FieldLink>}
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
