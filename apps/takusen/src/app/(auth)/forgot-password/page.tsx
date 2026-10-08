import { AuthFooterLink } from '@/components/auth-frame'
import { ForgotPasswordForm } from './forgot-password-form'

export const metadata = {
  title: 'Forgot password · Takusen',
}

export default function ForgotPasswordPage(): React.JSX.Element {
  return (
    <ForgotPasswordForm
      footer={
        <AuthFooterLink prompt="Remembered it?" href="/login">
          Back to sign in
        </AuthFooterLink>
      }
    />
  )
}
