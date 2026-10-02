import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import type { NextConfig } from 'next'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Local dev reads one env file: the repo-root .env (see /.env.example).
// loadEnvFile does not overwrite variables that are already set, so the real
// process env wins. Next.js itself still auto-loads apps/takusen/.env* before
// this runs; do not keep env files here, or they shadow the root file.
const rootEnv = resolve(__dirname, '../../.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // oidc-provider is server-only and uses dynamic requires; keep it external
  // so Next/webpack doesn't try to bundle it.
  serverExternalPackages: ['oidc-provider'],
  // @hachiman/client ships TS source (permissions + wire types), and
  // @hachiman/crypto ships TS source (the DS helpers of `@hachiman/crypto/ds`).
  transpilePackages: ['@hachiman/client', '@hachiman/crypto'],
  // The repo is a pnpm monorepo; pin the trace root to this app so Next
  // doesn't traverse the whole workspace looking for files to include.
  outputFileTracingRoot: __dirname,
}

export default nextConfig
