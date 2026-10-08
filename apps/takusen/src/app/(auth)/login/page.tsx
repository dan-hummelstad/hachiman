import { AuthFooterLink, AuthScreen } from '@/components/auth-frame'
import { safeNext } from '@/lib/safe-next'

import { AppRail, firstParam, fromApp, withNext, type SearchParam } from '../handoff'
import { LoginForm } from './login-form'

export const metadata = {
  title: 'Sign in · Takusen',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: SearchParam }>
}): Promise<React.JSX.Element> {
  const next = safeNext(firstParam((await searchParams).next))

  return (
    <AuthScreen rail={<AppRail next={next} label="Sign in" />}>
      <LoginForm
        next={next}
        forgotHref={withNext('/forgot-password', next)}
        lead={
          fromApp(next)
            ? 'Hachiman uses your Takusen account. Sign in once and you’ll go straight back.'
            : 'Use your Takusen email and password.'
        }
        footer={
          <AuthFooterLink prompt="New to Takusen?" href={withNext('/signup', next)}>
            Create an account
          </AuthFooterLink>
        }
      />
    </AuthScreen>
  )
}
