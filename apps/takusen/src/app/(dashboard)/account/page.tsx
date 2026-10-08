import { DashboardShell } from '@/components/dashboard-shell'
import { getAccountSummary } from '@/lib/account'
import { requireUser } from '@/lib/auth-helpers'
import { passwordAge } from '@/lib/format'

import { PasswordPanel } from './password-panel'
import { ProfilePanel } from './profile-panel'

export const metadata = {
  title: 'Account · Takusen',
}

export default async function AccountPage(): Promise<React.JSX.Element> {
  const session = await requireUser()
  const summary = await getAccountSummary(session.user.id)
  const email = summary?.email ?? session.user.email ?? ''
  const age = summary?.passwordChangedAt ? passwordAge(summary.passwordChangedAt, summary.createdAt) : null

  return (
    <DashboardShell
      section="account"
      crumbs={[{ label: 'Account' }]}
      title="Account"
      description="Your profile and password. Devices and encryption keys are managed in Hachiman."
    >
      <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
        <ProfilePanel
          displayName={summary?.displayName ?? session.user.name ?? ''}
          email={email}
          avatarUrl={summary?.avatarUrl ?? null}
        />
        {/* "changed 12 days ago": the head meta is lower case. */}
        <PasswordPanel email={email} changed={age && age.charAt(0).toLowerCase() + age.slice(1)} />
      </div>
    </DashboardShell>
  )
}
