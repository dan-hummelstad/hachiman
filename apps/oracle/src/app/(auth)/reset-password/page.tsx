import Link from 'next/link'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

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
      <Card>
        <CardHeader>
          <CardTitle>Invalid link</CardTitle>
          <CardDescription>
            This password reset link is missing a token.{' '}
            <Link
              href="/forgot-password"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Request a new one
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    )
  }

  return <ResetPasswordForm token={token} />
}
