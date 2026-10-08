import { DashboardSection, DashboardShell } from '@/components/dashboard-shell'
import { NAV_GROUPS } from '@/components/dashboard-nav-items'
import { LinkRows } from '@/components/link-rows'
import { initialsFor } from '@/components/initials'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { requireUser } from '@/lib/auth-helpers'

export const metadata = {
  title: 'Dashboard · Takusen',
}

const ACCOUNT_LINKS = NAV_GROUPS[0].items.filter((i) => i.description)

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const session = await requireUser()
  const name = session.user.name ?? ''
  const email = session.user.email ?? ''
  const displayName = name || email || 'there'

  return (
    <DashboardShell
      section="account"
      crumbs={[{ label: 'Overview' }]}
      title={`Welcome back, ${displayName}`}
      description="Your Takusen account. Guilds are managed in the Hachiman app."
    >
      <div className="flex items-center gap-4 border bg-card p-4">
        <Avatar className="size-14">
          <AvatarFallback className="text-lg">{initialsFor(name, email)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] leading-5 font-semibold">{name || email}</span>
            {session.user.role === 'admin' && <Badge variant="secondary">Admin</Badge>}
          </div>
          {name && <span className="truncate text-sm text-muted-foreground">{email}</span>}
        </div>
      </div>

      <DashboardSection title="Settings">
        <LinkRows items={ACCOUNT_LINKS} />
      </DashboardSection>
    </DashboardShell>
  )
}
