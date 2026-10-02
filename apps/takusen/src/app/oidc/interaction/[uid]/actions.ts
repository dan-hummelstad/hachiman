/**
 * Server actions for the OIDC consent / login interaction page.
 *
 * The page renders a small UI; these actions are what Allow / Deny call
 * into. Each one:
 *   1. Re-resolves the current Auth.js session (defence in depth — the
 *      page may have been left open across a logout).
 *   2. Reads interaction details via `getInteraction(uid)`.
 *   3. Builds an `InteractionResults` payload (login + consent grant, or
 *      an `error: 'access_denied'` for Deny).
 *   4. Calls `resumeInteraction(uid, result)` which writes the rotated
 *      `_interaction_resume` cookie and returns the URL to redirect to
 *      (typically `/api/oidc/auth/<uid>`, the provider's resume route).
 *   5. Mirrors any cookies the provider produced onto `next/headers`'
 *      cookie jar so the redirected request sees them.
 */
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/db/client'
import { oidcClients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getInteraction, resumeInteraction } from '@/lib/oidc-interaction'

async function applyCookies(
  setCookies: Array<{ name: string; value: string; options: Record<string, unknown> }>,
) {
  const jar = await cookies()
  for (const c of setCookies) {
    jar.set({
      name: c.name,
      value: c.value,
      path: typeof c.options.path === 'string' ? c.options.path : '/',
      maxAge: typeof c.options.maxAge === 'number' ? c.options.maxAge : undefined,
      expires: c.options.expires instanceof Date ? c.options.expires : undefined,
      domain: typeof c.options.domain === 'string' ? c.options.domain : undefined,
      sameSite:
        c.options.sameSite === 'strict' ||
        c.options.sameSite === 'lax' ||
        c.options.sameSite === 'none'
          ? c.options.sameSite
          : undefined,
      secure: c.options.secure === true,
      httpOnly: c.options.httpOnly === true,
    })
  }
}

export async function acceptInteractionAction(uid: string): Promise<void> {
  const session = await auth()
  if (!session?.user?.id) {
    redirect(`/login?next=${encodeURIComponent(`/oidc/interaction/${uid}`)}`)
  }

  const { provider, interaction } = await getInteraction(uid)
  const accountId = session.user.id

  const promptName = interaction.prompt.name

  // Always satisfy login if it's pending — we know the user is signed in.
  // Build / extend a Grant for consent prompts.
  let grantId: string | undefined = interaction.grantId
  if (promptName === 'consent') {
    const params = interaction.params as { client_id?: string; scope?: string }
    const clientId = String(params.client_id ?? '')
    const grant = grantId
      ? (await provider.Grant.find(grantId)) ?? new provider.Grant({ accountId, clientId })
      : new provider.Grant({ accountId, clientId })

    const requestedScopes = String(params.scope ?? '').split(' ').filter(Boolean)
    if (requestedScopes.length > 0) {
      grant.addOIDCScope(requestedScopes.join(' '))
    }

    // `details.missingOIDCScope` / `missingOIDCClaims` is what
    // oidc-provider asks us to acknowledge explicitly.
    const details = interaction.prompt.details as {
      missingOIDCScope?: string[]
      missingOIDCClaims?: string[]
      missingResourceScopes?: Record<string, string[]>
    }
    if (details.missingOIDCScope?.length) {
      grant.addOIDCScope(details.missingOIDCScope.join(' '))
    }
    if (details.missingOIDCClaims?.length) {
      grant.addOIDCClaims(details.missingOIDCClaims)
    }
    if (details.missingResourceScopes) {
      for (const [resource, scopes] of Object.entries(details.missingResourceScopes)) {
        grant.addResourceScope(resource, scopes.join(' '))
      }
    }

    grantId = await grant.save()
  }

  const result =
    promptName === 'login'
      ? { login: { accountId } }
      : { consent: grantId ? { grantId } : {} }

  const { redirectTo, cookies: setCookies } = await resumeInteraction(uid, result)
  await applyCookies(setCookies)
  redirect(redirectTo)
}

export async function denyInteractionAction(uid: string): Promise<void> {
  const { redirectTo, cookies: setCookies } = await resumeInteraction(uid, {
    error: 'access_denied',
    error_description: 'The end user denied the authorization request.',
  })
  await applyCookies(setCookies)
  redirect(redirectTo)
}

/**
 * Look up a human-friendly name + scope list for a client_id, so the
 * consent screen can render something nicer than the raw UUID.
 */
export async function describeClient(clientId: string): Promise<{
  name: string
  knownScopes: string[]
} | null> {
  const row = await db
    .select({
      scopes: oidcClients.scopes,
    })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1)
    .then((rows) => rows[0])

  if (!row) return null
  return {
    name: clientId,
    knownScopes: row.scopes,
  }
}
