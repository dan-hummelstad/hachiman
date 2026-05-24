import Link from 'next/link'

import { DashboardShell } from '@/components/dashboard-shell'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requireUser } from '@/lib/auth-helpers'

export const metadata = {
  title: 'Dashboard · Takusen',
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const session = await requireUser()
  const displayName = session.user.name ?? session.user.email ?? 'there'

  return (
    <DashboardShell
      title={`Welcome back, ${displayName}`}
      description="Your Takusen overview. Other panels (servers, invites) will appear here."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Servers</CardTitle>
            <CardDescription>
              Register a Mumble server or manage the ones you own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/servers">View servers</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Update your display name or change your password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/account">Open account</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Coming soon</CardTitle>
            <CardDescription>
              Invites, activity, and server stats will land here.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </div>
    </DashboardShell>
  )
}
