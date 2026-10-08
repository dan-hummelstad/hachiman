'use client'

import { ArrowLeftIcon, InboxIcon, KeyRoundIcon, MailCheckIcon, MailIcon, SendIcon } from 'lucide-react'
import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { AuthCard } from '@/components/auth-frame'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { requestPasswordResetAction, type FormActionResult } from '../actions'
import { CardNote, FormError, IconTile } from '../auth-parts'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full max-sm:h-12" disabled={pending}>
      <SendIcon aria-hidden />
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  )
}

const spamNote = <CardNote icon={InboxIcon}>No email after a minute? Check spam, then try again.</CardNote>

export function ForgotPasswordForm({
  next,
  loginHref,
  linkLifetime,
}: {
  next?: string
  loginHref: string
  linkLifetime: string
}): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    requestPasswordResetAction,
    undefined,
  )

  // The same confirmation whether or not the address has an account (anti-enumeration).
  if (state?.ok) {
    return (
      <AuthCard
        title="Check your inbox"
        lead={`${state.message ?? ''} It works for ${linkLifetime}.`}
        footer={spamNote}
        media={<IconTile icon={MailCheckIcon} />}
      >
        <Button asChild variant="secondary" size="lg" className="w-full max-sm:h-12">
          <Link href={loginHref}>
            <ArrowLeftIcon aria-hidden />
            Back to sign in
          </Link>
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Forgot your password?"
      lead={`Enter the email you signed up with. We’ll send a link to choose a new password; it works for ${linkLifetime}.`}
      footer={spamNote}
      media={
        <div className="flex items-center justify-between gap-3">
          <IconTile icon={KeyRoundIcon} />
          <Button asChild variant="quiet" size="sm">
            <Link href={loginHref}>
              <ArrowLeftIcon aria-hidden />
              Back to sign in
            </Link>
          </Button>
        </div>
      }
    >
      <form action={formAction} className="flex flex-col gap-[22px] max-sm:gap-[18px]">
        {state?.error && <FormError>{state.error}</FormError>}
        {next && <input type="hidden" name="next" value={next} />}
        <Field id="email" label="Email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            leading={<MailIcon aria-hidden />}
            required
            autoFocus
          />
        </Field>
        <SubmitButton />
      </form>
    </AuthCard>
  )
}
