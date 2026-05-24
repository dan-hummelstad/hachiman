import { eq } from 'drizzle-orm'

import { DashboardShell } from '@/components/dashboard-shell'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    <DashboardShell
      title="Account"
      description="Update your profile and security settings."
    >
      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Your display name is shown to other users.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="account-email">Email</Label>
              <Input
                id="account-email"
                type="email"
                value={user?.email ?? ''}
                readOnly
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Email address is currently not editable.
              </p>
            </div>
            <DisplayNameForm initialDisplayName={user?.displayName ?? ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Use a unique password at least 8 characters long.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
