'use client'

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

import { requestPasswordResetAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  )
}

export function ForgotPasswordForm(): React.JSX.Element {
  const [state, formAction] = useActionState<
    FormActionResult | undefined,
    FormData
  >(requestPasswordResetAction, undefined)

  // Surface the generic confirmation as a toast (anti-enumeration).
  useEffect(() => {
    if (state?.ok && state.message) {
      toast.success('Check your inbox', { description: state.message })
    }
  }, [state])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send a link to set a new password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {state?.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state?.ok && state.message && (
            <Alert>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </div>
          <SubmitButton />
        </form>
      </CardContent>
    </Card>
  )
}
