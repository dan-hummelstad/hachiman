'use client'

import Link from 'next/link'
import { useActionState, useEffect } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { resetPasswordAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Updating…' : 'Set new password'}
    </Button>
  )
}

export interface ResetPasswordFormProps {
  token: string
}

export function ResetPasswordForm({
  token,
}: ResetPasswordFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<
    FormActionResult | undefined,
    FormData
  >(resetPasswordAction, undefined)

  useEffect(() => {
    if (state?.ok && state.message) {
      toast.success('Password updated', { description: state.message })
    }
  }, [state])

  if (state?.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password updated</CardTitle>
          <CardDescription>
            {state.message ??
              'Your password has been changed. You can now sign in.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          Pick something at least 8 characters long.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {state?.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <input type="hidden" name="token" value={token} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
            />
          </div>
          <SubmitButton />
        </form>
      </CardContent>
    </Card>
  )
}
