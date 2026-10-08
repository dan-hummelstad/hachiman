import { DashboardShell } from '@/components/dashboard-shell'
import { getViewer } from '@/lib/account'
import { passwordAge } from '@/lib/format'

import { PasswordPanel } from './password-panel'
import { ProfilePanel } from './profile-panel'

export const metadata = {
  title: 'Account · Takusen',
}

export default async function AccountPage(): Promise<React.JSX.Element | null> {
  // Null only in the render inside a sign-out action; the layout sends signed-out visitors to /login.
  const viewer = await getViewer()
  if (!viewer) return null

  return (
    <DashboardShell
      section="account"
      crumbs={[{ label: 'Account' }]}
      title="Account"
      description="Your profile and password. Devices and encryption keys are managed in Hachiman."
    >
      <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
        <ProfilePanel displayName={viewer.displayName} email={viewer.email} avatarUrl={viewer.avatarUrl} />
        <PasswordPanel
          email={viewer.email}
          changed={
            viewer.passwordChangedAt && passwordAge(viewer.passwordChangedAt, viewer.createdAt, { lowerCase: true })
          }
        />
      </div>
    </DashboardShell>
  )
}
