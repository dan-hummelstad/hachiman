'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

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

import { loginAction, type FormActionResult } from '../actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export interface LoginFormProps {
  next?: string
}

export function LoginForm({ next }: LoginFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<FormActionResult | undefined, FormData>(
    loginAction,
    undefined,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to Takusen</CardTitle>
        <CardDescription>
          Use your Takusen email and password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {state?.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {next && <input type="hidden" name="next" value={next} />}
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
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <SubmitButton />
        </form>
      </CardContent>
    </Card>
  )
}
