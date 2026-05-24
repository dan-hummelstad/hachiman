/**
 * Per-server access-token minting.
 *
 * The Hachiman client calls POST /api/me/server-tokens immediately before
 * connecting to a Mumble server. We mint an opaque OAuth access token
 * scoped to *that server's* OIDC client. The Mumble server later calls
 * /api/oidc/token/introspection with its own client_id+secret; panva's
 * introspection naturally returns `active: false` if a different client
 * tries to introspect, which is exactly the audience binding we want.
 *
 * Why we go through the Provider's model classes rather than running a
 * full grant flow:
 *   - The user is already authenticated to Oracle via their Auth.js
 *     session, so an interactive `authorization_code` flow is overkill.
 *   - `client_credentials` would require the *client* to authenticate at
 *     the token endpoint, but the requester here is the Auth.js-session
 *     user, not the Mumble server itself.
 *   - Constructing `Grant` + `AccessToken` directly is the documented
 *     escape hatch for exactly this case: mint a token bound to (account,
 *     client) without an interactive grant flow. The token is persisted
 *     via the same Drizzle adapter the rest of the OP uses, so
 *     introspection / revocation work without any extra plumbing.
 */
import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { oidcClients, servers } from '@/db/schema'
import { getOidcProvider } from './oidc-provider'

export const SERVER_TOKEN_SCOPE = 'openid profile email'

export class ServerTokenServerNotFoundError extends Error {
  constructor(serverId: string) {
    super(`Server not found or has no OIDC client: ${serverId}`)
    this.name = 'ServerTokenServerNotFoundError'
  }
}

export interface MintedServerToken {
  accessToken: string
  /** Unix seconds. */
  expiresAt: number
  scope: string
  clientId: string
}

/**
 * Mint an opaque access token bound to the given Oracle-registered server's
 * OIDC client and the given account (the signed-in user).
 *
 * Throws ServerTokenServerNotFoundError if the server doesn't exist or has
 * no oidcClients row.
 */
export async function mintServerToken(
  accountId: string,
  serverId: string,
): Promise<MintedServerToken> {
  const rows = await db
    .select({
      clientId: oidcClients.clientId,
    })
    .from(servers)
    .innerJoin(oidcClients, eq(oidcClients.serverId, servers.id))
    .where(eq(servers.id, serverId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    throw new ServerTokenServerNotFoundError(serverId)
  }

  const provider = await getOidcProvider()

  // Look up the Client through the OP's own machinery — this funnels
  // through the adapter and gives us a fully-constructed Client instance
  // that the AccessToken constructor accepts.
  const client = await provider.Client.find(row.clientId)
  if (!client) {
    throw new ServerTokenServerNotFoundError(serverId)
  }

  // Mint a fresh Grant + AccessToken pair. The Grant carries the user's
  // OIDC consent (openid/profile/email) for this client and is the parent
  // record that AccessToken.grantId points at — required by panva so that
  // `revokeByGrantId` can clean up the token if the user disconnects.
  const grant = new provider.Grant({
    accountId,
    clientId: row.clientId,
  })
  grant.addOIDCScope(SERVER_TOKEN_SCOPE)
  const grantId = await grant.save()

  const accessToken = new provider.AccessToken({
    client,
    accountId,
    grantId,
    scope: SERVER_TOKEN_SCOPE,
    gty: 'authorization_code',
  })

  const value = await accessToken.save()
  // `expiration` is set by panva after save() based on the configured TTL.
  // `exp` is the absolute unix-seconds timestamp; fall back to TTL math if
  // panva ever changes the shape.
  const exp =
    typeof accessToken.exp === 'number'
      ? accessToken.exp
      : Math.floor(Date.now() / 1000) + accessToken.expiration

  return {
    accessToken: value,
    expiresAt: exp,
    scope: SERVER_TOKEN_SCOPE,
    clientId: row.clientId,
  }
}
