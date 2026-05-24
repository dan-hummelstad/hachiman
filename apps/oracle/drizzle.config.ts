import type { Config } from 'drizzle-kit'

if (!process.env.DATABASE_URL) {
  // drizzle-kit will load .env via its own mechanism in newer versions, but
  // surface a clear error if nothing is set when running CLI tasks.
  // eslint-disable-next-line no-console
  console.warn('[drizzle.config] DATABASE_URL not set — generate will still work without it.')
}

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://oracle:oracle@localhost:5432/oracle',
  },
  strict: true,
  verbose: true,
} satisfies Config
