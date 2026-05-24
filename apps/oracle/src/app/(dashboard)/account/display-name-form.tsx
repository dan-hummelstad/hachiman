'use client'

import { useActionState, useEffect } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  updateDisplayNameAction,
  type AccountActionResult,
} from './actions'

function SubmitButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )
}

export interface DisplayNameFormProps {
  initialDisplayName: string
}

export function DisplayNameForm({
  initialDisplayName,
}: DisplayNameFormProps): React.JSX.Element {
  const [state, formAction] = useActionState<
    AccountActionResult | undefined,
    FormData
  >(updateDisplayNameAction, undefined)

  useEffect(() => {
    if (state?.ok && state.message) {
      toast.success(state.message)
    }
  }, [state])

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          name="displayName"
          type="text"
          defaultValue={initialDisplayName}
          autoComplete="nickname"
          required
          maxLength={64}
        />
      </div>
      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  )
}
