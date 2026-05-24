import Link from 'next/link'

import { ForgotPasswordForm } from './forgot-password-form'

export const metadata = {
  title: 'Forgot password · Takusen',
}

export default function ForgotPasswordPage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <ForgotPasswordForm />
      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link
          href="/login"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
