import { AuthScreen } from '@/components/auth-frame'
import { formatDuration } from '@/lib/format'
import { RESET_TOKEN_TTL_MS } from '@/lib/password-reset'
import { safeNext } from '@/lib/safe-next'

import { firstParam, withNext, type SearchParam } from '../handoff'
import { ForgotPasswordForm } from './forgot-password-form'

export const metadata = {
  title: 'Forgot password · Takusen',
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: SearchParam }>
}): Promise<React.JSX.Element> {
  const next = safeNext(firstParam((await searchParams).next))

  return (
    <AuthScreen promise={false}>
      <ForgotPasswordForm next={next} loginHref={withNext('/login', next)} linkLifetime={formatDuration(RESET_TOKEN_TTL_MS / 1000)} />
    </AuthScreen>
  )
}
