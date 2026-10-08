'use client'

import { AtSignIcon, MailIcon } from 'lucide-react'
import Link from 'next/link'
import { useActionState, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

import { AuthCard, TRUST_LINKS } from '@/components/auth-frame'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'

import { signupAction, type FormActionResult } from '../actions'
import { FormError, PasswordMeter } from '../auth-parts'
import { PASSWORD_MIN_LENGTH } from '@/lib/password-strength'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full max-sm:h-12" disabled={pending}>
      {pending ? 'Creating account…' : 'Create account'}
    </Button>
  )
}

const legalLink = 'underline-offset-4 hover:text-text-secondary hover:underline'
const TERMS_HREF = TRUST_LINKS.find((l) => l.label === 'Terms')?.href ?? '/'
const PRIVACY_HREF = TRUST_LINKS.find((l) => l.label === 'Privacy')?.href ?? '/'

export function SignupForm({ next, footer }: { next?: string; footer?: ReactNode }): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    signupAction,
    undefined,
  )
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <AuthCard
      title="Create your Takusen account"
      lead="One account for every Hachiman guild, on desktop and in the browser."
      footer={footer}
    >
      <form action={formAction} className="flex flex-col gap-[22px] max-sm:gap-[18px]">
        {state?.error && <FormError>{state.error}</FormError>}
        {next && <input type="hidden" name="next" value={next} />}
        <div className="flex flex-col gap-4 max-sm:gap-3.5">
          <Field id="displayName" label="Display name" hint="Shown to other people. You can change it later.">
            <Input
              id="displayName"
              name="displayName"
              type="text"
              autoComplete="nickname"
              leading={<AtSignIcon aria-hidden />}
              aria-describedby="displayName-hint"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={64}
            />
          </Field>
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
          <Field id="password" label="Password">
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              aria-describedby="password-meter"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={PASSWORD_MIN_LENGTH}
            />
            <PasswordMeter id="password-meter" password={password} email={email} />
          </Field>
        </div>
        <div className="flex flex-col gap-3">
          <SubmitButton />
          <p className="text-center text-[12.5px] leading-[1.5] font-medium text-text-tertiary">
            By continuing you agree to the{' '}
            <Link href={TERMS_HREF} className={legalLink}>
              Terms
            </Link>{' '}
            and{' '}
            <Link href={PRIVACY_HREF} className={legalLink}>
              Privacy policy
            </Link>
            .
          </p>
        </div>
      </form>
    </AuthCard>
  )
}
