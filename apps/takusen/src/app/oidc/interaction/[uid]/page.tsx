/**
 * OIDC interaction page — the consent / "continue as" screen the user sees
 * when a relying party (e.g. the Hachiman app) starts an
 * authorization request and the OP needs explicit user action.
 *
 * Mounted at `/oidc/interaction/[uid]` — NOT under /api, because we want
 * the normal Next.js page lifecycle (Auth.js session read, server actions).
 */
import { redirect } from 'next/navigation'
import { CheckIcon } from 'lucide-react'

import { initialsFor } from '@/components/initials'
import { Window, WindowScreen } from '@/components/window'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { auth } from '@/auth'
import { getInteraction } from '@/lib/oidc-interaction'

import {
  acceptInteractionAction,
  denyInteractionAction,
  describeClient,
} from './actions'

interface PageProps {
  params: Promise<{ uid: string }>
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'Confirm your identity',
  profile: 'Read your display name',
  email: 'Read your email address',
  offline_access: 'Stay signed in to that server',
}

export default async function InteractionPage({ params }: PageProps) {
  const { uid } = await params
  const session = await auth()

  // Validate the interaction up front. If the cookie is missing / expired,
  // `getInteraction` will throw — let Next render the default error page.
  const { interaction } = await getInteraction(uid)

  // No session → kick to /login with a `next` that returns the browser here.
  if (!session?.user?.id) {
    const next = `/oidc/interaction/${uid}`
    redirect(`/login?next=${encodeURIComponent(next)}`)
  }

  const promptName = interaction.prompt.name
  const params2 = interaction.params as { client_id?: string; scope?: string }
  const clientId = String(params2.client_id ?? '')
  const requestedScopes = String(params2.scope ?? '')
    .split(' ')
    .filter(Boolean)

  const clientInfo = clientId ? await describeClient(clientId) : null
  const displayName = clientInfo?.name ?? clientId ?? 'an unknown application'

  // Bind the server actions to this interaction's uid so the form can call
  // them without a hidden input.
  const accept = acceptInteractionAction.bind(null, uid)
  const deny = denyInteractionAction.bind(null, uid)

  const userName = session.user.name ?? ''
  const userEmail = session.user.email ?? ''

  const identity = (
    <div className="flex items-center gap-3">
      <Avatar className="size-10">
        <AvatarFallback>{initialsFor(userName, userEmail)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold">{userName || userEmail}</span>
        {userName && (
          <span className="truncate text-xs leading-4 text-muted-foreground">{userEmail}</span>
        )}
      </div>
    </div>
  )

  if (promptName === 'login') {
    return (
      <WindowScreen>
        <Window
          title={`Continue as ${userName || userEmail}?`}
          footer={
            <div className="flex justify-end gap-2">
              <form action={deny}>
                <Button type="submit" variant="outline">
                  Cancel
                </Button>
              </form>
              <form action={accept}>
                <Button type="submit">Continue</Button>
              </form>
            </div>
          }
        >
          {identity}
          <p className="text-sm text-muted-foreground">
            {displayName} would like to know who you are.
          </p>
        </Window>
      </WindowScreen>
    )
  }

  // Default: consent prompt (or anything else we don't have a custom UI for).
  return (
    <WindowScreen className="max-w-[420px]">
      <Window
        title={`Authorize ${displayName}`}
        footer={
          <div className="flex justify-end gap-2">
            <form action={deny}>
              <Button type="submit" variant="outline">
                Deny
              </Button>
            </form>
            <form action={accept}>
              <Button type="submit">Allow</Button>
            </form>
          </div>
        }
      >
        <p className="text-sm">
          <span className="font-semibold">{displayName}</span> would like to access your
          account. Granting access lets this server identify you across sessions.
        </p>
        <div className="flex flex-col gap-2">
          <h2 className="section-label">Signed in as</h2>
          {identity}
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="section-label">It will be able to</h2>
          {requestedScopes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scopes requested.</p>
          ) : (
            <ul className="flex flex-col border">
              {requestedScopes.map((scope) => (
                <li
                  key={scope}
                  className="flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0"
                >
                  <CheckIcon aria-hidden className="size-4 shrink-0 text-online" />
                  <span className="min-w-0 flex-1 text-sm">
                    {SCOPE_DESCRIPTIONS[scope] ?? scope}
                  </span>
                  <code className="font-mono text-xs text-muted-foreground">{scope}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Window>
    </WindowScreen>
  )
}
