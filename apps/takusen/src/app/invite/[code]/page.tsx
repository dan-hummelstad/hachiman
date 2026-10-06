import { Window, WindowScreen } from '@/components/window'
import { getInvitePreview } from '@/lib/invites'
import { OpenInviteButtons } from './open-invite-buttons'

export const dynamic = 'force-dynamic'

interface InvitePageProps {
  params: Promise<{ code: string }>
}

function guildInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

// Public, non-consuming landing page. Joining happens in the app
// (POST /api/v1/invites/:code), reached via the deep link or the web client.
// OpenInviteButtons hands on the `#k=` key of an invite with history.
export default async function InvitePage({ params }: InvitePageProps): Promise<React.JSX.Element> {
  const { code } = await params
  const preview = await getInvitePreview(code)

  if (!preview) {
    return (
      <WindowScreen>
        <Window title="Invite unavailable">
          <p className="text-sm text-muted-foreground">
            This invite is invalid, expired, or has been revoked. Ask whoever sent it for a new
            one.
          </p>
        </Window>
      </WindowScreen>
    )
  }

  const encoded = encodeURIComponent(code)
  const webUrl = process.env.HACHIMAN_WEB_URL ?? 'http://localhost:5173'

  return (
    <WindowScreen>
      <Window
        title="Guild invite"
        footer={
          <OpenInviteButtons
            webHref={`${webUrl}/invite/${encoded}`}
            appHref={`takusen://invite/${encoded}`}
          />
        }
      >
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center border bg-rail text-lg leading-none font-semibold"
          >
            {guildInitials(preview.guild.name)}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm text-muted-foreground">You&apos;ve been invited to join</p>
            <h2 className="truncate text-xl leading-7 font-semibold">{preview.guild.name}</h2>
            <p className="text-xs leading-4 text-muted-foreground tabular-nums">
              {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
            </p>
          </div>
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          Invite code <span className="font-mono text-[13px] text-foreground">{code}</span>
        </p>
      </Window>
    </WindowScreen>
  )
}
