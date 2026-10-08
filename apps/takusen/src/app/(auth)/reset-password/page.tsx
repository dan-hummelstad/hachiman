import { LinkIcon } from 'lucide-react'
import Link from 'next/link'

import { AuthCard, AuthScreen } from '@/components/auth-frame'
import { Button } from '@/components/ui/button'
import { hashResetToken, resetTokenEmail } from '@/lib/password-reset'

import { IconTile } from '../auth-parts'
import { firstParam, safeNext, withNext, type SearchParam } from '../handoff'
import { ResetPasswordForm } from './reset-password-form'

export const metadata = {
  title: 'Reset password · Takusen',
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: SearchParam; next?: SearchParam }>
}): Promise<React.JSX.Element> {
  const params = await searchParams
  const token = firstParam(params.token)
  const next = safeNext(firstParam(params.next))
  const email = token ? await resetTokenEmail(hashResetToken(token), new Date()) : null

  return (
    <AuthScreen promise={false}>
      {token && email ? (
        <ResetPasswordForm token={token} email={email} loginHref={withNext('/login', next)} />
      ) : (
        <AuthCard
          media={<IconTile icon={LinkIcon} />}
          title="This link doesn’t work"
          lead={
            token
              ? 'This password reset link has expired or was already used.'
              : 'This password reset link is missing a token.'
          }
        >
          <Button asChild size="lg" className="w-full max-sm:h-12">
            <Link href={withNext('/forgot-password', next)}>Request a new link</Link>
          </Button>
        </AuthCard>
      )}
    </AuthScreen>
  )
}
