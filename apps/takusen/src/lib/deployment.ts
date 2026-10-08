/**
 * Facts about this deployment for the dashboard: its name and tag for the admin
 * page bar, and the Hachiman links that the launcher, the invite pages and the
 * sign-in hand-off use.
 */
import type { DesktopPlatform } from '@/lib/desktop-update'

export interface DeploymentInfo {
  /** `TAKUSEN_DEPLOYMENT_NAME`, else the host of `NEXTAUTH_URL`, else "takusen". */
  name: string
  /** `TAKUSEN_DEPLOYMENT_TAG` (e.g. "preview"), or null when unset. */
  tag: string | null
}

type Env = Readonly<Record<string, string | undefined>>

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

export function deploymentInfo(env: Env = process.env): DeploymentInfo {
  const name = env.TAKUSEN_DEPLOYMENT_NAME?.trim() || hostOf(env.NEXTAUTH_URL) || 'takusen'
  const tag = env.TAKUSEN_DEPLOYMENT_TAG?.trim() || null
  return { name, tag }
}

export interface HachimanLinks {
  /** The web app origin (`HACHIMAN_WEB_URL`). */
  web: string
  /** Opens the desktop app (its deep-link scheme, contract §11). */
  app: string
  /** The desktop build download (contract §4 Desktop updates). 404 when updates are not configured. */
  download: Record<DesktopPlatform, string>
}

export function hachimanLinks(env: Env = process.env): HachimanLinks {
  return {
    web: (env.HACHIMAN_WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    app: 'takusen://',
    download: { macos: '/api/desktop-update/macos/download', windows: '/api/desktop-update/windows/download' },
  }
}

/** The invite in the web app and in the desktop app. */
export function inviteLinks(code: string, env: Env = process.env): { web: string; app: string } {
  const encoded = encodeURIComponent(code)
  return { web: `${hachimanLinks(env).web}/invite/${encoded}`, app: `takusen://invite/${encoded}` }
}
