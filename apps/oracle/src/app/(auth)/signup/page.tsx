import Link from 'next/link'

import { SignupForm } from './signup-form'

export const metadata = {
  title: 'Create your account · Takusen',
}

export default function SignupPage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <SignupForm />
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href="/login"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  )
}
