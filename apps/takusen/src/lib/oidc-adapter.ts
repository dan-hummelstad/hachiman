/**
 * Drizzle-backed Adapter for the panva oidc-provider.
 *
 * Storage strategy: one table (`oidcAdapterPayloads`) keyed on (model, id),
 * with the JSON payload stored verbatim under `payload`. A handful of
 * top-level columns (`grantId`, `userCode`, `uid`, `expiresAt`, `consumedAt`)
 * are hoisted out of the payload at write time so we can satisfy the
 * Adapter's secondary-index queries (`findByUid`, `findByUserCode`,
 * `revokeByGrantId`) and the eventual TTL sweeper without scanning JSON.
 *
 * Special case — `name === 'Client'`:
 *   Clients are managed via the Takusen registry CRUD and live in the
 *   `oidcClients` table. `find('client_id')` translates that row into the
 *   shape oidc-provider expects (`AllClientMetadata`). `upsert` / `destroy`
 *   for the Client model are deliberate no-ops; the OP never writes clients.
 */
import { and, eq, lte, sql } from 'drizzle-orm'
import type { Adapter, AdapterPayload, AllClientMetadata } from 'oidc-provider'

import { db } from '@/db/client'
import { oidcAdapterPayloads, oidcClients } from '@/db/schema'

const CLIENT_MODEL = 'Client'

export class DrizzleAdapter implements Adapter {
  constructor(private readonly name: string) {}

  // ---- Client passthrough ----------------------------------------------
  private async findClient(clientId: string): Promise<AdapterPayload | undefined> {
    const row = await db
      .select({
        clientId: oidcClients.clientId,
        clientSecret: oidcClients.clientSecret,
        isPublic: oidcClients.isPublic,
        redirectUris: oidcClients.redirectUris,
        scopes: oidcClients.scopes,
      })
      .from(oidcClients)
      .where(eq(oidcClients.clientId, clientId))
      .limit(1)
      .then((rows) => rows[0])

    if (!row) return undefined

    if (row.isPublic) {
      // Public PKCE client: omit client_secret and use 'none' auth method.
      // `application_type: 'native'` loosens panva's redirect URI scheme
      // validation so reverse-DNS custom schemes like `app.hachiman://oauth-callback` and
      // loopback URLs like `http://localhost:5173/...` are both accepted.
      const metadata: AllClientMetadata = {
        client_id: row.clientId,
        client_name: row.clientId,
        redirect_uris: row.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: row.scopes.join(' '),
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }
      return metadata as AdapterPayload
    }

    // Confidential client. If it declares no redirect URIs, a placeholder
    // satisfies panva's metadata validator — it demands non-empty
    // `redirect_uris` whenever `authorization_code` (or `implicit`) appears in `grant_types`, and rejects unknown grant
    // types like `client_credentials` unless that whole feature is enabled.
    // A loopback HTTP placeholder is the lowest-friction option: valid for
    // `application_type: 'web'`, never resolved by any real client.
    const PLACEHOLDER_REDIRECT_URI = 'http://localhost/takusen-unused-redirect'
    const declaredRedirectUris =
      row.redirectUris.length > 0
        ? row.redirectUris
        : [PLACEHOLDER_REDIRECT_URI]
    const metadata: AllClientMetadata = {
      client_id: row.clientId,
      client_secret: row.clientSecret,
      client_name: row.clientId,
      redirect_uris: declaredRedirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: row.scopes.join(' '),
      token_endpoint_auth_method: 'client_secret_basic',
    }
    return metadata as AdapterPayload
  }

  // ---- Adapter contract ------------------------------------------------

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    if (this.name === CLIENT_MODEL) {
      // Registry owns client lifecycle.
      return
    }

    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null
    const consumedAt =
      payload.consumed != null
        ? typeof payload.consumed === 'number'
          ? new Date(payload.consumed * 1000)
          : new Date()
        : null

    await db
      .insert(oidcAdapterPayloads)
      .values({
        id,
        model: this.name,
        payload: payload as Record<string, unknown>,
        grantId: payload.grantId ?? null,
        userCode: payload.userCode ?? null,
        uid: payload.uid ?? null,
        expiresAt,
        consumedAt,
      })
      .onConflictDoUpdate({
        target: [oidcAdapterPayloads.model, oidcAdapterPayloads.id],
        set: {
          payload: payload as Record<string, unknown>,
          grantId: payload.grantId ?? null,
          userCode: payload.userCode ?? null,
          uid: payload.uid ?? null,
          expiresAt,
          consumedAt,
        },
      })
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    if (this.name === CLIENT_MODEL) {
      return this.findClient(id)
    }

    const row = await db
      .select()
      .from(oidcAdapterPayloads)
      .where(
        and(eq(oidcAdapterPayloads.model, this.name), eq(oidcAdapterPayloads.id, id)),
      )
      .limit(1)
      .then((rows) => rows[0])

    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return undefined
    return row.payload as AdapterPayload
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    if (this.name === CLIENT_MODEL) return undefined

    const row = await db
      .select()
      .from(oidcAdapterPayloads)
      .where(
        and(
          eq(oidcAdapterPayloads.model, this.name),
          eq(oidcAdapterPayloads.userCode, userCode),
        ),
      )
      .limit(1)
      .then((rows) => rows[0])

    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return undefined
    return row.payload as AdapterPayload
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    if (this.name === CLIENT_MODEL) return undefined

    const row = await db
      .select()
      .from(oidcAdapterPayloads)
      .where(
        and(eq(oidcAdapterPayloads.model, this.name), eq(oidcAdapterPayloads.uid, uid)),
      )
      .limit(1)
      .then((rows) => rows[0])

    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return undefined
    return row.payload as AdapterPayload
  }

  async consume(id: string): Promise<void> {
    if (this.name === CLIENT_MODEL) return

    const now = new Date()
    const nowSec = Math.floor(now.getTime() / 1000)
    await db
      .update(oidcAdapterPayloads)
      .set({
        consumedAt: now,
        // Mirror the consumed timestamp into the payload so subsequent
        // `find()` calls hand oidc-provider an object it recognises as
        // "already consumed" without us having to mutate it on the way out.
        payload: sql`jsonb_set(${oidcAdapterPayloads.payload}, '{consumed}', to_jsonb(${nowSec}::int))`,
      })
      .where(
        and(eq(oidcAdapterPayloads.model, this.name), eq(oidcAdapterPayloads.id, id)),
      )
  }

  async destroy(id: string): Promise<void> {
    if (this.name === CLIENT_MODEL) return

    await db
      .delete(oidcAdapterPayloads)
      .where(
        and(eq(oidcAdapterPayloads.model, this.name), eq(oidcAdapterPayloads.id, id)),
      )
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await db
      .delete(oidcAdapterPayloads)
      .where(eq(oidcAdapterPayloads.grantId, grantId))
  }
}

/**
 * Best-effort sweeper for expired rows. Wire this up from a cron job or
 * periodic task in deployment; oidc-provider does not call it itself.
 */
export async function pruneExpiredOidcPayloads(now: Date = new Date()): Promise<number> {
  const deleted = await db
    .delete(oidcAdapterPayloads)
    .where(lte(oidcAdapterPayloads.expiresAt, now))
    .returning({ id: oidcAdapterPayloads.id })
  return deleted.length
}
