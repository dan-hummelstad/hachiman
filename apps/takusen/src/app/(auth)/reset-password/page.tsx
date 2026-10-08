import { Window } from '@/components/window'

import { AuthFooterLink } from '@/components/auth-frame'
import { ResetPasswordForm } from './reset-password-form'

export const metadata = {
  title: 'Reset password · Takusen',
}

interface ResetPasswordPageProps {
  searchParams: Promise<{ token?: string | string[] }>
}

function pickToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps): Promise<React.JSX.Element> {
  const { token: tokenParam } = await searchParams
  const token = pickToken(tokenParam)

  if (!token) {
    return (
      <Window
        title="Invalid link"
        footer={
          <AuthFooterLink prompt="Need a new link?" href="/forgot-password">
            Request a new one
          </AuthFooterLink>
        }
      >
        <p className="text-sm text-muted-foreground">
          This password reset link is missing a token.
        </p>
      </Window>
    )
  }

  return <ResetPasswordForm token={token} />
}
