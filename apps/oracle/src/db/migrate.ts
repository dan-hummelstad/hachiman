/**
 * Programmatic migration runner. Invoked by `pnpm db:migrate`.
 *
 * Uses a one-shot postgres connection (max: 1) per the postgres-js docs'
 * recommendation for migrations.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const sql = postgres(databaseUrl, { max: 1 })
  const db = drizzle(sql)
  await migrate(db, { migrationsFolder: './drizzle' })

  await sql.end()
   
  console.log('[oracle] migrations applied')
}

main().catch((err) => {
   
  console.error('[oracle] migration failed', err)
  process.exit(1)
})
