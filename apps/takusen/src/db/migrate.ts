/**
 * Programmatic migration runner. Invoked by `pnpm db:migrate`.
 *
 * Uses a one-shot postgres connection (max: 1) per the postgres-js docs'
 * recommendation for migrations.
 *
 * Each pending migration runs in its own transaction. Drizzle's `migrate()` runs them all in one,
 * and Postgres refuses a new enum value in the transaction that added it (55P04): `0004_threads`
 * adds `channel_type` 'thread' and `0005` uses it in an index. The bookkeeping is drizzle's own
 * (the `drizzle.__drizzle_migrations` table, a row of hash and created_at per migration, pending
 * = created_at above the newest row), so a database migrated by either runner suits the other.
 */
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`
  const [last] = await sql<{ created_at: string }[]>`
    SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`
  const applied = last ? Number(last.created_at) : -Infinity

  for (const m of readMigrationFiles({ migrationsFolder: './drizzle' })) {
    if (m.folderMillis <= applied) continue
    await sql.begin(async (tx) => {
      for (const stmt of m.sql) await tx.unsafe(stmt)
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${m.hash}, ${m.folderMillis})`
    })
  }

  await sql.end()

  console.log('[takusen] migrations applied')
}

main().catch((err) => {
  console.error('[takusen] migration failed', err)
  process.exit(1)
})
