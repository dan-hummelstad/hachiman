import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { getInvitePreview } from '@/lib/invites'

export const dynamic = 'force-dynamic'

interface InvitePageProps {
  params: Promise<{ code: string }>
}

// Public, non-consuming landing page. Joining happens in the app
// (POST /api/v1/invites/:code), reached via the deep link or the web client.
export default async function InvitePage({ params }: InvitePageProps): Promise<React.JSX.Element> {
  const { code } = await params
  const preview = await getInvitePreview(code)

  if (!preview) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invite unavailable</CardTitle>
            <CardDescription>This invite is invalid, expired, or has been revoked.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    )
  }

  const encoded = encodeURIComponent(code)
  const webUrl = process.env.HACHIMAN_WEB_URL ?? 'http://localhost:5173'

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardDescription>You&apos;ve been invited to join</CardDescription>
          <CardTitle>{preview.guild.name}</CardTitle>
          <CardDescription>
            {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col gap-2">
          <Button asChild className="w-full">
            <a href={`takusen://invite/${encoded}`}>Open in Hachiman</a>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <a href={`${webUrl}/invite/${encoded}`}>Open in browser</a>
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
