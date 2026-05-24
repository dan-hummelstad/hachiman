import Link from 'next/link'

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
    <div className="flex flex-col gap-4">
      <LoginForm next={nextPath} />
      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link
          href="/signup"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </p>
    </div>
  )
}
