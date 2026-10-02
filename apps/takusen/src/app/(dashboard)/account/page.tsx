import { eq } from 'drizzle-orm'

import { DashboardSection, DashboardShell } from '@/components/dashboard-shell'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { requireUser } from '@/lib/auth-helpers'

import { ChangePasswordForm } from './change-password-form'
import { DisplayNameForm } from './display-name-form'

export const metadata = {
  title: 'Account · Takusen',
}

export default async function AccountPage(): Promise<React.JSX.Element> {
  const session = await requireUser()
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { displayName: true, email: true },
  })

  return (
    <DashboardShell title="Account" description="Update your profile and security settings.">
      <DashboardSection
        title="Profile"
        description="Your display name is shown to other users."
      >
        <div className="flex max-w-[420px] flex-col gap-5">
          <Field id="account-email" label="Email" hint="Email address is currently not editable.">
            <Input
              id="account-email"
              type="email"
              value={user?.email ?? ''}
              readOnly
              disabled
            />
          </Field>
          <DisplayNameForm initialDisplayName={user?.displayName ?? ''} />
        </div>
      </DashboardSection>

      <DashboardSection
        title="Change password"
        description="Use a unique password at least 8 characters long."
      >
        <div className="max-w-[420px]">
          <ChangePasswordForm />
        </div>
      </DashboardSection>
    </DashboardShell>
  )
}
