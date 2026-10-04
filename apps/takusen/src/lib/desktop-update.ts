/**
 * Desktop app updates (contract §4 Desktop updates). The builds are the GitHub Actions artifacts
 * of .github/workflows/desktop.yml. Downloading an artifact always needs a GitHub token, so
 * Takusen holds it (TAKUSEN_UPDATE_GITHUB_TOKEN, read-only "Actions" on the repo) and the desktop
 * app holds no secret: it asks Takusen for the newest build and gets a redirect to GitHub's
 * short-lived signed zip URL.
 */
const ARTIFACTS = { macos: 'hachiman-macos', windows: 'hachiman-windows' } as const
export type DesktopPlatform = keyof typeof ARTIFACTS

export function isDesktopPlatform(p: string): p is DesktopPlatform {
  return Object.hasOwn(ARTIFACTS, p)
}

/** The fields of a GitHub Actions artifact (REST `GET /repos/{repo}/actions/artifacts`) that Takusen reads. */
export interface Artifact {
  name: string
  expired: boolean
  created_at: string
  archive_download_url: string
  /** `sha256:<hex>` of the zip (upload-artifact v4). */
  digest?: string | null
  workflow_run?: { head_sha?: string; head_branch?: string } | null
}

export interface DesktopBuild {
  /** The commit the build is from. The app compares it with its own. */
  sha: string
  /** Hex SHA-256 of the artifact zip. */
  sha256: string
  archiveUrl: string
}

export function newestBuild(artifacts: Artifact[], name: string): DesktopBuild | null {
  const a = artifacts
    .filter((a) => a.name === name && !a.expired && a.workflow_run?.head_branch === 'main')
    .sort((x, y) => y.created_at.localeCompare(x.created_at))[0]
  const sha = a?.workflow_run?.head_sha
  if (!a || !sha || !a.digest?.startsWith('sha256:')) return null
  return { sha, sha256: a.digest.slice('sha256:'.length), archiveUrl: a.archive_download_url }
}

// ponytail: per-process 60 s cache keeps the app checks inside GitHub's 5000/h token limit.
const CACHE_MS = 60_000
const cache = new Map<DesktopPlatform, { at: number; build: DesktopBuild | null }>()

function config(): { repo: string; token: string } | null {
  const repo = process.env.TAKUSEN_UPDATE_GITHUB_REPO
  const token = process.env.TAKUSEN_UPDATE_GITHUB_TOKEN
  return repo && token ? { repo, token } : null
}

function github(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    // The zip URL redirects to a signed blob URL. Takusen passes it on and never follows it.
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
  const name = ARTIFACTS[platform]
  const res = await github(`https://api.github.com/repos/${cfg.repo}/actions/artifacts?name=${name}&per_page=20`, cfg.token)
  if (!res.ok) throw new Error(`GitHub artifact list: HTTP ${res.status}`)
  const { artifacts } = (await res.json()) as { artifacts: Artifact[] }
  const build = newestBuild(artifacts, name)
  cache.set(platform, { at: Date.now(), build })
  return build
}

/** A signed URL of the newest build's zip (valid for about a minute), or null. */
export async function desktopBuildZipUrl(platform: DesktopPlatform): Promise<string | null> {
  const cfg = config()
  const build = cfg && (await latestDesktopBuild(platform))
  if (!cfg || !build) return null
  const res = await github(build.archiveUrl, cfg.token)
  const location = res.headers.get('location')
  if (res.status !== 302 || !location) throw new Error(`GitHub artifact zip: HTTP ${res.status}`)
  return location
}
