import { AuthFooterLink, AuthScreen } from '@/components/auth-frame'
import { safeNext } from '@/lib/safe-next'

import { AppRail, firstParam, withNext, type SearchParam } from '../handoff'
import { SignupForm } from './signup-form'

export const metadata = {
  title: 'Create your account · Takusen',
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: SearchParam }>
}): Promise<React.JSX.Element> {
  const next = safeNext(firstParam((await searchParams).next))

  return (
    <AuthScreen rail={<AppRail next={next} label="Create account" />} promise={false}>
      <SignupForm
        next={next}
        footer={
          <AuthFooterLink prompt="Already have an account?" href={withNext('/login', next)}>
            Sign in
          </AuthFooterLink>
        }
      />
    </AuthScreen>
  )
}
