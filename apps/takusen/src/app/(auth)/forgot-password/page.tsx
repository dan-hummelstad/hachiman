import { AuthScreen } from '@/components/auth-frame'
import { RESET_TOKEN_TTL_MS } from '@/lib/password-reset'

import { firstParam, safeNext, withNext, type SearchParam } from '../handoff'
import { ForgotPasswordForm } from './forgot-password-form'

export const metadata = {
  title: 'Forgot password · Takusen',
}

function formatTtl(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minutes`
  const hours = minutes / 60
  return hours === 1 ? 'an hour' : `${hours} hours`
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: SearchParam }>
}): Promise<React.JSX.Element> {
  const next = safeNext(firstParam((await searchParams).next))

  return (
    <AuthScreen promise={false}>
      <ForgotPasswordForm next={next} loginHref={withNext('/login', next)} linkLifetime={formatTtl(RESET_TOKEN_TTL_MS)} />
    </AuthScreen>
  )
}
