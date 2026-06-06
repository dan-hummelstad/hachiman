/**
 * OIDC client management used by the registry UI: read the client for a
 * server, update its redirect URIs, regenerate its secret. The secret is
 * stored plaintext (high-entropy, DB is the trust boundary) because
 * oidc-provider compares the wire-presented secret to the stored value
 * directly with no hash hook.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db/client'
import { oidcClients, type OidcClient } from '@/db/schema'

export const redirectUrisSchema = z
  .array(
    z
      .string()
      .url('Each redirect URI must be a valid URL')
      .max(2048, 'Redirect URI is too long'),
  )
  .max(20, 'Too many redirect URIs')

export async function getOidcClientForServer(
  serverId: string,
): Promise<OidcClient | null> {
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.virtualServerId, serverId))
    .limit(1)
  return rows[0] ?? null
}

export async function updateRedirectUris(
  serverId: string,
  uris: string[],
): Promise<OidcClient> {
  const parsed = redirectUrisSchema.parse(uris)
  const rows = await db
    .update(oidcClients)
    .set({ redirectUris: parsed })
    .where(eq(oidcClients.virtualServerId, serverId))
    .returning()
  const row = rows[0]
  if (!row) {
    throw new Error('OIDC client not found for server')
  }
  return row
}

function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  let str = ''
  for (const b of buf) str += String.fromCharCode(b)
  return Buffer.from(str, 'binary').toString('base64url')
}

export interface RegeneratedSecret {
  client: OidcClient
  /** Plain-text. Shown once. */
  secret: string
}

export async function regenerateClientSecret(
  serverId: string,
): Promise<RegeneratedSecret> {
  const secret = randomBase64Url(32)
  const rows = await db
    .update(oidcClients)
    .set({ clientSecret: secret })
    .where(eq(oidcClients.virtualServerId, serverId))
    .returning()
  const row = rows[0]
  if (!row) {
    throw new Error('OIDC client not found for server')
  }
  return { client: row, secret }
}
