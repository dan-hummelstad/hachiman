import { AuthFooterLink } from '../auth-link'
import { SignupForm } from './signup-form'

export const metadata = {
  title: 'Create your account · Takusen',
}

export default function SignupPage(): React.JSX.Element {
  return (
    <SignupForm
      footer={
        <AuthFooterLink prompt="Already have an account?" href="/login">
          Sign in
        </AuthFooterLink>
      }
    />
  )
}
