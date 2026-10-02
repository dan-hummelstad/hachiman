/**
 * OIDC interaction page — the consent / "continue as" screen the user sees
 * when a relying party (e.g. the Hachiman app) starts an
 * authorization request and the OP needs explicit user action.
 *
 * Mounted at `/oidc/interaction/[uid]` — NOT under /api, because we want
 * the normal Next.js page lifecycle (Auth.js session read, server actions).
 */
import { redirect } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

  if (promptName === 'login') {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center p-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Continue as {session.user.name ?? session.user.email}?</CardTitle>
            <CardDescription>
              {displayName} would like to know who you are.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-end gap-2">
            <form action={deny}>
              <Button type="submit" variant="outline">
                Cancel
              </Button>
            </form>
            <form action={accept}>
              <Button type="submit">Continue</Button>
            </form>
          </CardFooter>
        </Card>
      </main>
    )
  }

  // Default: consent prompt (or anything else we don't have a custom UI for).
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{displayName} would like to access your account</CardTitle>
          <CardDescription>
            Signed in as <span className="font-medium">{session.user.email}</span>.
            Granting access lets this server identify you across sessions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {requestedScopes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scopes requested.</p>
          ) : (
            requestedScopes.map((scope) => (
              <Badge
                key={scope}
                variant="secondary"
                title={SCOPE_DESCRIPTIONS[scope] ?? scope}
              >
                {scope}
              </Badge>
            ))
          )}
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <form action={deny}>
            <Button type="submit" variant="outline">
              Deny
            </Button>
          </form>
          <form action={accept}>
            <Button type="submit">Allow</Button>
          </form>
        </CardFooter>
      </Card>
    </main>
  )
}
