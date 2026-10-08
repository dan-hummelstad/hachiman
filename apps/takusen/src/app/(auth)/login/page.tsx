import { AuthFooterLink } from '@/components/auth-frame'
import { HandoffRail, type HandoffStep } from '@/components/handoff-rail'

import { LoginForm } from './login-form'

export const metadata = {
  title: 'Sign in · Takusen',
}

interface LoginPageProps {
  searchParams: Promise<{ next?: string | string[] }>
}

function pickNext(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

// An OIDC interaction means Hachiman sent the visitor here and gets them back after sign-in.
const FROM_HACHIMAN: readonly HandoffStep[] = [
  { product: 'hachiman', label: 'Hachiman', state: 'done' },
  { product: 'takusen', label: 'Sign in', state: 'current' },
  { product: 'hachiman', label: 'Back to Hachiman', state: 'next' },
]

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.JSX.Element> {
  const { next } = await searchParams
  const nextPath = pickNext(next)
  const fromHachiman = nextPath?.startsWith('/oidc/interaction/') ?? false

  return (
    <>
      {fromHachiman && <HandoffRail steps={FROM_HACHIMAN} />}
      <LoginForm
        next={nextPath}
        lead={
          fromHachiman
            ? 'Hachiman uses your Takusen account. Sign in once and you’ll go straight back.'
            : 'Use your Takusen email and password.'
        }
        footer={
          <AuthFooterLink prompt="New to Takusen?" href="/signup">
            Create an account
          </AuthFooterLink>
        }
      />
    </>
  )
}
