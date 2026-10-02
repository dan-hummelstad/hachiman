import { AuthFooterLink } from '../auth-link'
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

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.JSX.Element> {
  const { next } = await searchParams
  const nextPath = pickNext(next)

  return (
    <LoginForm
      next={nextPath}
      footer={
        <AuthFooterLink prompt="Don’t have an account?" href="/signup">
          Create one
        </AuthFooterLink>
      }
    />
  )
}
