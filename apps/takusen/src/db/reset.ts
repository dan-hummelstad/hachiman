/**
 * Empties the dev database: drops the `public` and `drizzle` schemas and creates `public` again.
 * `db:reset` runs it, then db:migrate and db:seed. Schemas still change during development, so a
 * reset replaces stacked ALTER migrations (see CLAUDE.md "Dev DB schema churn").
 *
 * It refuses to run with NODE_ENV=production.
 */
import postgres from 'postgres'

if (process.env.NODE_ENV === 'production') {
  console.error('[db] refusing to reset with NODE_ENV=production')
  process.exit(1)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error('[db] DATABASE_URL is not set')
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
sql
  .unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  .then(async () => {
    console.log(`[db] reset ${new URL(url).pathname.slice(1)}`)
    await sql.end()
  })
  .catch(async (err: unknown) => {
    console.error('[db] reset failed', err)
    await sql.end()
    process.exit(1)
  })
