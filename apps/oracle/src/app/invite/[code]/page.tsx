import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  buildJoinUri,
  getInviteByCode,
  InviteExpiredError,
  InviteExhaustedError,
  InviteRevokedError,
  InviteNotFoundError,
} from '@/lib/invite-signing'
import { getServerById } from '@/lib/servers'
import { OpenInAppButton } from './_components/open-in-app-button'

interface InvitePageProps {
  params: Promise<{ code: string }>
}

export default async function InvitePage({ params }: InvitePageProps): Promise<React.JSX.Element> {
  const { code } = await params
  const invite = await getInviteByCode(code)

  if (!invite) return <InviteErrorCard title="Invite not found" message="This invite code is invalid or has been deleted." />
  if (invite.revoked) return <InviteErrorCard title="Invite revoked" message="The server owner has revoked this invite." />
  // RSC executes on the server per request; Date.now() is fine here. The
  // react-hooks/purity rule can't distinguish RSC from client components.
  // eslint-disable-next-line react-hooks/purity
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    return <InviteErrorCard title="Invite expired" message="This invite has passed its expiration date." />
  }
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return <InviteErrorCard title="Invite exhausted" message="This invite has reached its maximum number of uses." />
  }

  const server = await getServerById(invite.virtualServerId)
  if (!server) return <InviteErrorCard title="Server unavailable" message="The server backing this invite is no longer registered." />

  // Pre-built fallback URI for the "Open in browser" path — preview only, does
  // not consume a use (consumption happens through the redeem POST below when
  // the user actually clicks "Open in App").
  const browserHash = buildJoinUri(server).split('#')[1] ?? ''

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{server.name}</CardTitle>
          {server.description ? <CardDescription>{server.description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Address</span>
            <span className="font-mono">
              {server.host}:{server.port}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Domain</span>
            {server.verifiedAt ? (
              <Badge variant="default">Verified</Badge>
            ) : (
              <Badge variant="outline">Unverified</Badge>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <OpenInAppButton code={code} className="w-full" />
          <Button asChild variant="outline" className="w-full">
            <Link href={`/join#${browserHash}`}>Open in browser</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}

function InviteErrorCard({ title, message }: { title: string; message: string }): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}

// Re-export so the route module isn't tree-shaken into nothing when bundling.
export { InviteExpiredError, InviteExhaustedError, InviteRevokedError, InviteNotFoundError }
