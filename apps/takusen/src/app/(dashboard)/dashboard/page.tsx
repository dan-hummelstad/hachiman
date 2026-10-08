import { headers } from 'next/headers'

import { IdentityCard, NextStepPanel, SecurityPanel } from '@/components/account/overview-cards'
import { AppsPanel, SessionsPanel, type SessionRowData } from '@/components/account/overview-panels'
import { DashboardShell } from '@/components/dashboard-shell'
import { getViewer, listAppAccess, listHachimanSessions } from '@/lib/account'
import { describeUserAgent, type HachimanSession } from '@/lib/account-sessions'
import { desktopDownloadFor, hachimanLinks } from '@/lib/deployment'
import { formatDate, formatRelative, passwordAge, plural } from '@/lib/format'

export const metadata = {
  title: 'Overview · Takusen',
}

/**
 * Takusen keeps no location or OS for a Hachiman sign-in: only the device the app
 * registered ("Hachiman Desktop" / "Hachiman Web"), and the time of the last token.
 */
function sessionRow(s: HachimanSession): SessionRowData {
  const when = formatRelative(s.lastActiveAt)
  if (!s.device) {
    return { grantId: s.grantId, icon: 'app', title: 'Hachiman', meta: `No device set up yet · ${when}` }
  }
  const desktop = s.device.platform === 'electron'
  const where = desktop ? 'Desktop app' : 'In the browser'
  const revoked = s.device.status === 'revoked' ? ' · device removed' : ''
  return {
    grantId: s.grantId,
    icon: desktop ? 'desktop' : 'web',
    title: s.device.name,
    meta: `${where} · v${s.device.clientVersion}${revoked} · ${when}`,
  }
}

export default async function DashboardPage(): Promise<React.JSX.Element | null> {
  // The layout sends signed-out visitors to /login. Null covers one case it does not: "Sign out
  // everywhere else" sets a new cookie, so Next re-renders this page inside the action, still
  // with the old cookie that the cut-off revoked. The client refreshes right after.
  const viewer = await getViewer()
  if (!viewer) return null
  const [sessions, apps, hdrs] = await Promise.all([
    listHachimanSessions(viewer.id),
    listAppAccess(viewer.id),
    headers(),
  ])
  const links = hachimanLinks()
  const browser = describeUserAgent(hdrs.get('user-agent'))
  const firstName = viewer.displayName || viewer.email
  const firstVisit = viewer.hachiman === 'never'

  return (
    <DashboardShell
      section="account"
      crumbs={[{ label: 'Overview' }]}
      title={firstVisit ? `Welcome to Takusen, ${firstName}` : `Welcome back, ${firstName}`}
      description={
        firstVisit
          ? 'Your account is ready. Open Hachiman to find your guilds, or join one with an invite link.'
          : 'Your Takusen account signs you in to Hachiman. Guilds, channels and messages live in the app.'
      }
    >
      {firstVisit ? (
        <NextStepPanel
          downloadHref={desktopDownloadFor(hdrs.get('user-agent'), links)}
          webHref={links.web}
          steps={[
            { title: 'Create your Takusen account', meta: 'Done', state: 'done' },
            { title: 'Open Hachiman and sign in', meta: 'Next', state: 'next' },
            {
              title: 'Join a guild',
              meta: viewer.guildCount > 0 ? 'Done' : 'Open any invite link',
              state: viewer.guildCount > 0 ? 'done' : 'todo',
            },
          ]}
        />
      ) : (
        <IdentityCard
          name={viewer.displayName}
          email={viewer.email}
          avatarUrl={viewer.avatarUrl}
          admin={viewer.role === 'admin'}
          memberSince={formatDate(viewer.createdAt)}
        />
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        <SessionsPanel
          browser={{ label: browser.label, mobile: browser.mobile }}
          sessions={sessions.map(sessionRow)}
        />
        <div className="flex min-w-0 flex-col gap-5">
          <SecurityPanel
            email={viewer.email}
            emailVerified={viewer.emailVerified}
            passwordLine={passwordAge(viewer.passwordChangedAt, viewer.createdAt)}
            showDeviceKeys={!firstVisit}
            hachimanWeb={links.web}
          />
          <AppsPanel
            apps={apps.map((a) => ({
              clientId: a.clientId,
              sessionCount: a.sessionCount,
              meta: `${plural(a.scopes.length, 'permission', 'permissions')} · since ${formatDate(a.since)}`,
            }))}
          />
        </div>
      </div>
    </DashboardShell>
  )
}
