import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import type { NextConfig } from 'next'

const __dirname = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // oidc-provider is server-only and uses dynamic requires; keep it external
  // so Next/webpack doesn't try to bundle it.
  serverExternalPackages: ['oidc-provider'],
  // The repo is a pnpm monorepo; pin the trace root to this app so Next
  // doesn't traverse the whole workspace looking for files to include.
  outputFileTracingRoot: __dirname,
}

export default nextConfig
