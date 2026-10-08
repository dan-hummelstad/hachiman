import { headers } from 'next/headers'

import { IdentityCard, NextStepPanel, SecurityPanel } from '@/components/account/overview-cards'
import { AppsPanel, SessionsPanel, type SessionRowData } from '@/components/account/overview-panels'
import { DashboardShell } from '@/components/dashboard-shell'
import { getAccountSummary, listAppAccess, listHachimanSessions } from '@/lib/account'
import { describeUserAgent, type HachimanSession } from '@/lib/account-sessions'
import { getOptionalUser } from '@/lib/auth-helpers'
import { hachimanLinks } from '@/lib/deployment'
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
  const session = await getOptionalUser()
  if (!session) return null
  const userId = session.user.id
  const [summary, sessions, apps, hdrs] = await Promise.all([
    getAccountSummary(userId),
    listHachimanSessions(userId),
    listAppAccess(userId),
    headers(),
  ])
  const links = hachimanLinks()
  const browser = describeUserAgent(hdrs.get('user-agent'))
  const name = summary?.displayName || session.user.name || ''
  const email = summary?.email ?? session.user.email ?? ''
  const firstName = name || email
  const firstVisit = summary?.hachiman === 'never'

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
          downloadHref={browser.os === 'Windows' ? links.download.windows : links.download.macos}
          webHref={links.web}
          steps={[
            { title: 'Create your Takusen account', meta: 'Done', state: 'done' },
            { title: 'Open Hachiman and sign in', meta: 'Next', state: 'next' },
            {
              title: 'Join a guild',
              meta: summary.guildCount > 0 ? 'Done' : 'Open any invite link',
              state: summary.guildCount > 0 ? 'done' : 'todo',
            },
          ]}
        />
      ) : (
        <IdentityCard
          name={name}
          email={email}
          avatarUrl={summary?.avatarUrl ?? null}
          admin={session.user.role === 'admin'}
          memberSince={summary ? formatDate(summary.createdAt) : ''}
        />
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        <SessionsPanel
          browser={{ label: browser.label, mobile: browser.mobile }}
          sessions={sessions.map(sessionRow)}
        />
        <div className="flex min-w-0 flex-col gap-5">
          <SecurityPanel
            email={email}
            emailVerified={summary?.emailVerified ?? false}
            passwordLine={summary ? passwordAge(summary.passwordChangedAt, summary.createdAt) : 'Set'}
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
