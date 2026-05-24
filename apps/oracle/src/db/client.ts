/**
 * Drizzle + postgres-js singleton.
 *
 * Reuses one `postgres` connection pool across hot reloads in dev. The pool
 * lives on `globalThis` so Next.js's per-request module evaluation doesn't
 * leak connections.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  // Typecheck-friendly: only throws at runtime. Build-time `next build` will
  // also fail if this is hit, which is intentional — we don't want a deploy
  // without a database to silently succeed.
  throw new Error('DATABASE_URL is not set')
}

declare global {
   
  var __oraclePostgresClient: ReturnType<typeof postgres> | undefined
}

const client =
  globalThis.__oraclePostgresClient ??
  postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
  })

if (process.env.NODE_ENV !== 'production') {
  globalThis.__oraclePostgresClient = client
}

export const db = drizzle(client, { schema })

export type Database = typeof db
export { schema }
