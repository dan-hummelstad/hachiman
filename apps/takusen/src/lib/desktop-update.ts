/**
 * Desktop app updates (contract §4 Desktop updates). The builds are the zip assets of the newest
 * release in the release repository, which .github/workflows/desktop.yml publishes. Takusen holds
 * a GitHub token (TAKUSEN_UPDATE_GITHUB_TOKEN, read-only "Contents" on that repo), so the repo can
 * be private and the desktop app holds no secret: it asks Takusen for the newest build and gets a
 * redirect to GitHub's short-lived signed asset URL.
 */
const ASSETS = { macos: 'hachiman-macos.zip', windows: 'hachiman-windows.zip' } as const
export type DesktopPlatform = keyof typeof ASSETS

export function isDesktopPlatform(p: string): p is DesktopPlatform {
  return Object.hasOwn(ASSETS, p)
}

/** The fields of a GitHub release (REST `GET /repos/{repo}/releases/latest`) that Takusen reads. */
export interface Release {
  /** The release notes. The workflow writes the source commit as a line `Commit: <sha>`. */
  body?: string | null
  assets: { name: string; url: string; digest?: string | null }[]
}

export interface DesktopBuild {
  /** The commit the build is from. The app compares it with its own. */
  sha: string
  /** Hex SHA-256 of the zip. */
  sha256: string
  /** The REST URL of the asset. */
  assetUrl: string
}

export function releaseBuild(release: Release, name: string): DesktopBuild | null {
  const sha = /^Commit: ([0-9a-f]{40})$/m.exec(release.body ?? '')?.[1]
  const asset = release.assets.find((a) => a.name === name)
  if (!sha || !asset?.digest?.startsWith('sha256:')) return null
  return { sha, sha256: asset.digest.slice('sha256:'.length), assetUrl: asset.url }
}

// ponytail: per-process 60 s cache keeps the app checks inside GitHub's 5000/h token limit.
const CACHE_MS = 60_000
const cache = new Map<DesktopPlatform, { at: number; build: DesktopBuild | null }>()

function config(): { repo: string; token: string } | null {
  const repo = process.env.TAKUSEN_UPDATE_GITHUB_REPO
  const token = process.env.TAKUSEN_UPDATE_GITHUB_TOKEN
  return repo && token ? { repo, token } : null
}

function github(url: string, token: string, accept = 'application/vnd.github+json'): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    // The asset download redirects to a signed blob URL. Takusen passes it on and never follows it.
    redirect: 'manual',
    cache: 'no-store',
  })
}

/** The newest build for `platform`, or null when updates are not configured or there is no build. */
export async function latestDesktopBuild(platform: DesktopPlatform): Promise<DesktopBuild | null> {
  const cfg = config()
  if (!cfg) return null
  const hit = cache.get(platform)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.build
  const res = await github(`https://api.github.com/repos/${cfg.repo}/releases/latest`, cfg.token)
  // 404: the repo has no release yet.
  if (!res.ok && res.status !== 404) throw new Error(`GitHub latest release: HTTP ${res.status}`)
  const build = res.ok ? releaseBuild((await res.json()) as Release, ASSETS[platform]) : null
  cache.set(platform, { at: Date.now(), build })
  return build
}

/** A signed URL of the newest build's zip (valid for about a minute), or null. */
export async function desktopBuildZipUrl(platform: DesktopPlatform): Promise<string | null> {
  const cfg = config()
  const build = cfg && (await latestDesktopBuild(platform))
  if (!cfg || !build) return null
  const res = await github(build.assetUrl, cfg.token, 'application/octet-stream')
  const location = res.headers.get('location')
  if (res.status !== 302 || !location) throw new Error(`GitHub release asset: HTTP ${res.status}`)
  return location
}
