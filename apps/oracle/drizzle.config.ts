import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Config } from 'drizzle-kit'

// Local dev reads the repo-root .env (see /.env.example). drizzle-kit runs
// from apps/oracle. Variables that are already set win.
const rootEnv = resolve(process.cwd(), '../../.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

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
