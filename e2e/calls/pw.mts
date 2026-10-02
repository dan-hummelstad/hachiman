/**
 * Loads Playwright. The repo does not depend on it yet (see README.md), so this looks in order:
 *   1. E2EE_CALLS_PLAYWRIGHT: the directory of an installed `playwright` package
 *   2. `playwright` resolvable from the repo
 *   3. a copy in the npx cache (~/.npm/_npx/<hash>/node_modules/playwright), newest stable first
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Playwright = typeof import('playwright')

function npxCopies(): string[] {
  const base = join(homedir(), '.npm/_npx')
  if (!existsSync(base)) return []
  const found: { dir: string; version: string }[] = []
  for (const h of readdirSync(base)) {
    const dir = join(base, h, 'node_modules/playwright')
    const pkg = join(dir, 'package.json')
    if (!existsSync(pkg)) continue
    const version = (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version
    found.push({ dir, version })
  }
  // Stable releases before prereleases: the browsers of `playwright install` match a stable build.
  const rank = (v: string): number => (v.includes('-') ? 1 : 0)
  found.sort((a, b) => rank(a.version) - rank(b.version) || b.version.localeCompare(a.version, undefined, { numeric: true }))
  return found.map((f) => f.dir)
}

export function loadPlaywright(): Playwright {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.E2EE_CALLS_PLAYWRIGHT, 'playwright', ...npxCopies()].filter(
    (c): c is string => !!c
  )
  for (const c of candidates) {
    try {
      return require(c) as Playwright
    } catch {
      // next candidate
    }
  }
  throw new Error('e2e/calls: Playwright not found. Set E2EE_CALLS_PLAYWRIGHT to a playwright package directory.')
}
