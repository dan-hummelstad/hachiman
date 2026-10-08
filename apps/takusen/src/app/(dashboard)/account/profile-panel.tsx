'use client'

import { AtSignIcon, CircleAlertIcon, CircleCheckIcon, LockIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useRef, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'

import { PROFILE_IMAGE_TYPES } from '@hachiman/client/files'

import { EntityAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Panel, PanelFooter, PanelHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { updateDisplayNameAction, type AccountActionResult } from './actions'

function SaveButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  )
}

async function apiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
  return body?.message ?? body?.error ?? `Request failed (${res.status})`
}

/**
 * The avatar goes through the public REST API (contract §4: upload, then PATCH
 * /users/@me), which accepts the dashboard cookie. It saves at once, apart from
 * the display name form.
 */
async function setAvatar(file: File | null): Promise<void> {
  let avatar: string | null = null
  if (file) {
    const up = await fetch(`/api/v1/uploads?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    })
    if (!up.ok) throw new Error(await apiError(up))
    avatar = ((await up.json()) as { id: string }).id
  }
  const res = await fetch('/api/v1/users/@me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ avatar }),
  })
  if (!res.ok) throw new Error(await apiError(res))
}

function AvatarRow({
  name,
  email,
  avatarUrl,
}: {
  name: string
  email: string
  avatarUrl: string | null
}): React.JSX.Element {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const run = (file: File | null): void => {
    setError(null)
    start(async () => {
      try {
        await setAvatar(file)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the avatar')
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3.5">
      <EntityAvatar src={avatarUrl} name={name} email={email} size={60} tone="gold" />
      <div className="flex min-w-[180px] flex-1 flex-col gap-[3px]">
        <span className="text-sm leading-[18px] font-extrabold">Avatar</span>
        {error ? (
          <span role="alert" className="text-[12.5px] font-semibold text-feature-danger-text">
            {error}
          </span>
        ) : (
          <span className="text-[12.5px] font-medium text-text-tertiary">
            PNG, JPEG, GIF or WebP. Shown as a circle.
          </span>
        )}
      </div>
      <div className="flex gap-1">
        <input
          ref={fileRef}
          type="file"
          accept={PROFILE_IMAGE_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) run(file)
          }}
        />
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => fileRef.current?.click()}>
          {pending ? 'Saving…' : 'Change'}
        </Button>
        {avatarUrl && (
          <Button type="button" variant="quiet" size="sm" disabled={pending} onClick={() => run(null)}>
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}

export interface ProfilePanelProps {
  displayName: string
  email: string
  avatarUrl: string | null
}

/** E2 Profile: avatar (saves at once), display name (Save changes), email (read only). */
export function ProfilePanel({ displayName, email, avatarUrl }: ProfilePanelProps): React.JSX.Element {
  const [state, formAction] = useActionState<AccountActionResult | undefined, FormData>(
    updateDisplayNameAction,
    undefined,
  )
  const [value, setValue] = useState(displayName)
  // Feedback belongs to the last save; typing again clears it.
  const [edited, setEdited] = useState(false)
  const shown = edited ? undefined : state
  const fieldError = shown?.field === 'displayName' ? shown.error : undefined
  const formError = shown && !shown.ok && !fieldError ? shown.error : undefined

  return (
    <Panel>
      <PanelHeader title="Profile" />
      <form action={formAction} onSubmit={() => setEdited(false)} className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-5 p-5">
          <AvatarRow name={displayName} email={email} avatarUrl={avatarUrl} />
          <Field
            id="displayName"
            label="Display name"
            hint="Shown to people in your guilds."
            error={fieldError}
          >
            <Input
              id="displayName"
              name="displayName"
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setEdited(true)
              }}
              leading={<AtSignIcon aria-hidden />}
              autoComplete="nickname"
              required
              maxLength={64}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'displayName-error' : 'displayName-hint'}
            />
          </Field>
          <Field id="account-email" label="Email" hint="Email can't be changed here yet. Ask an admin if you need to.">
            <Input
              id="account-email"
              type="email"
              value={email}
              readOnly
              leading={<LockIcon aria-hidden />}
              aria-describedby="account-email-hint"
            />
          </Field>
        </div>
        <PanelFooter className="bg-transparent px-5 py-3">
          <p aria-live="polite" className="min-w-0 flex-1 text-[13px] font-bold">
            {shown?.ok && (
              <span className="flex items-center gap-1.5 text-feature-voice-text">
                <CircleCheckIcon aria-hidden className="size-[15px] shrink-0" />
                Saved just now
              </span>
            )}
            {formError && (
              <span className="flex items-center gap-1.5 text-feature-danger-text">
                <CircleAlertIcon aria-hidden className="size-[15px] shrink-0" />
                {formError}
              </span>
            )}
          </p>
          <SaveButton />
        </PanelFooter>
      </form>
    </Panel>
  )
}
