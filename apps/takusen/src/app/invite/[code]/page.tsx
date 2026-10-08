import {
  ArrowUpRightIcon,
  AudioLinesIcon,
  Link2OffIcon,
  MessageCircleIcon,
  PanelLeftIcon,
  TicketIcon,
  UserRoundIcon,
} from 'lucide-react'
import Link from 'next/link'

import { AuthCard, AuthScreen } from '@/components/auth-frame'
import { initialsFor } from '@/components/initials'
import { AccountChip, UserAvatar, type SsoAccount } from '@/components/sso-account'
import { StatusTag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAccountSummary } from '@/lib/account'
import { getOptionalUser } from '@/lib/auth-helpers'
import { hachimanLinks, inviteLinks } from '@/lib/deployment'
import { getInviteLanding, type DeadInvite, type UsableInvite } from '@/lib/invite-landing'

import { InviteCodeChip } from './invite-code-chip'
import { NotYouButton, OpenInviteButtons } from './open-invite-buttons'

export const dynamic = 'force-dynamic'

interface InvitePageProps {
  params: Promise<{ code: string }>
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "in 6 days" / "2 days ago", in the largest whole unit. */
function relative(iso: string): string {
  const diff = Date.parse(iso) - Date.now()
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.trunc(diff / ms), unit)
  }
  return rtf.format(Math.trunc(diff / 1000), 'second')
}

// Public, non-consuming landing page. Joining happens in the app
// (POST /api/v1/invites/:code), reached via the deep link or the web client.
// OpenInviteButtons hands on the `#k=` key of an invite with history.
export default async function InvitePage({ params }: InvitePageProps): Promise<React.JSX.Element> {
  const { code } = await params
  const session = await getOptionalUser()
  const viewerId = session?.user.id ?? null
  const [landing, summary] = await Promise.all([
    getInviteLanding(code, viewerId),
    viewerId ? getAccountSummary(viewerId) : null,
  ])
  const account: SsoAccount | null = session
    ? {
        name: summary?.displayName ?? session.user.name ?? '',
        email: summary?.email ?? session.user.email ?? '',
        avatarUrl: summary?.avatarUrl ?? null,
      }
    : null

  return (
    <AuthScreen topBarEnd={account ? <AccountChip account={account} /> : undefined}>
      {landing.status === 'ok' ? (
        <GuildInvite invite={landing} account={account} />
      ) : (
        <InviteUnavailable invite={landing} />
      )}
    </AuthScreen>
  )
}

function GuildInvite({
  invite,
  account,
}: {
  invite: UsableInvite
  account: SsoAccount | null
}): React.JSX.Element {
  const { guild } = invite
  const links = inviteLinks(invite.code)
  return (
    <AuthCard
      title={<span className="text-[30px] leading-[1.15] tracking-[-0.5px]">{guild.name}</span>}
      bodyClassName="gap-5 pt-0 sm:gap-5 sm:px-8 sm:pt-0 sm:pb-7"
      banner={
        <div className="relative h-[124px] sm:h-[146px]">
          <div
            aria-hidden
            className="h-[76px] bg-surface-raised bg-cover bg-center sm:h-24"
            style={guild.bannerUrl ? { backgroundImage: `url(${guild.bannerUrl})` } : undefined}
          />
          <span className="absolute bottom-3.5 left-5 sm:left-8">
            <GuildIcon name={guild.name} iconUrl={guild.iconUrl} />
          </span>
        </div>
      }
      media={
        invite.inviter && (
          <p className="flex items-center gap-2 text-[13.5px] leading-5 font-semibold text-text-secondary">
            <UserAvatar
              account={{ name: invite.inviter.displayName, email: '', avatarUrl: invite.inviter.avatarUrl }}
              size={22}
            />
            <span className="min-w-0 truncate">{invite.inviter.displayName} invited you to join</span>
          </p>
        )
      }
      footer={
        account && (
          <div className="flex w-full min-w-0 items-center gap-2 text-[13.5px] leading-5">
            <span className="font-medium text-text-tertiary">Joining as</span>
            <UserAvatar account={account} size={20} />
            <span className="min-w-0 truncate font-extrabold text-text-primary">
              {account.name || account.email}
            </span>
            <NotYouButton />
          </div>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13.5px] leading-5">
        {invite.members.length > 0 && (
          <span className="flex -space-x-1.5">
            {invite.members.map((m) => (
              <UserAvatar
                key={m.id}
                account={{ name: m.displayName, email: '', avatarUrl: m.avatarUrl }}
                size={28}
                className="border-2 border-surface-content"
              />
            ))}
          </span>
        )}
        <span className="flex items-center gap-1.5 font-bold text-text-secondary">
          <span aria-hidden className="size-2 rounded-full bg-status-online" />
          {invite.onlineCount} online
        </span>
        <span className="font-semibold text-text-tertiary">
          {invite.memberCount} {invite.memberCount === 1 ? 'member' : 'members'}
        </span>
        {guild.region && (
          <span className="flex items-center gap-[5px] font-mono text-xs text-text-tertiary max-sm:hidden">
            <AudioLinesIcon aria-hidden className="size-3.5 text-feature-voice-text" />
            <span className="sr-only">Voice region</span>
            {guild.region}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5 border-t border-line-hairline pt-3.5">
        <span className="text-[13px] font-bold text-text-tertiary max-sm:hidden">Invite code</span>
        <InviteCodeChip code={invite.code} />
        {invite.expiresAt && (
          <span className="ml-auto shrink-0 text-[12.5px] font-medium text-text-tertiary">
            Expires {relative(invite.expiresAt)}
          </span>
        )}
      </div>

      <OpenInviteButtons webHref={links.web} appHref={links.app} />
    </AuthCard>
  )
}

function GuildIcon({ name, iconUrl }: { name: string; iconUrl: string | null }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="flex size-[60px] items-center justify-center overflow-hidden rounded-full border-[3px] border-surface-content bg-accent-tint bg-cover bg-center text-xl font-extrabold text-accent-text sm:size-[72px] sm:text-2xl"
      style={iconUrl ? { backgroundImage: `url(${iconUrl})` } : undefined}
    >
      {!iconUrl && initialsFor(name, '')}
    </span>
  )
}

const DEAD: Record<DeadInvite['status'], { title: string; tag: string }> = {
  expired: { title: 'This invite has expired', tag: 'Expired' },
  revoked: { title: 'This invite was revoked', tag: 'Revoked' },
  exhausted: { title: 'This invite is used up', tag: 'Used up' },
  unknown: { title: "This invite doesn't exist", tag: 'Unknown' },
}

function deadDetail(invite: DeadInvite): string {
  switch (invite.status) {
    case 'expired':
      return invite.expiredAt ? `This one expired ${relative(invite.expiredAt)}.` : 'This one has expired.'
    case 'revoked':
      return 'This one was revoked.'
    case 'exhausted':
      return 'This one has no uses left.'
    case 'unknown':
      return 'Check that you have the whole link.'
  }
}

function InviteUnavailable({ invite }: { invite: DeadInvite }): React.JSX.Element {
  const copy = DEAD[invite.status]
  return (
    <AuthCard
      title={copy.title}
      lead={`Invites can expire, run out of uses or be revoked by a guild admin. ${deadDetail(invite)}`}
      media={
        <span
          aria-hidden
          className="flex size-11 items-center justify-center bg-feature-danger/15 text-feature-danger-text"
        >
          <Link2OffIcon className="size-5" />
        </span>
      }
    >
      <div className="flex items-center gap-2.5 border border-line-hairline bg-surface-raised px-3.5 py-3">
        <TicketIcon aria-hidden className="size-4 shrink-0 text-text-tertiary" />
        <s className="min-w-0 truncate font-mono text-sm font-semibold tracking-[1px] text-text-tertiary decoration-feature-danger-text decoration-[1.5px]">
          {invite.code}
        </s>
        <StatusTag tone="danger" className="ml-auto">
          {copy.tag}
        </StatusTag>
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="section-label">What you can do</h2>
        <ul className="flex flex-col text-sm leading-[1.5] font-medium text-text-secondary">
          <li className="flex gap-3 py-2">
            <MessageCircleIcon aria-hidden className="mt-0.5 size-[17px] shrink-0 text-gold-text" />
            Ask whoever sent it for a fresh invite.
          </li>
          <li className="flex gap-3 py-2">
            <PanelLeftIcon aria-hidden className="mt-0.5 size-[17px] shrink-0 text-gold-text" />
            {invite.guildName
              ? `Already a member? ${invite.guildName} is in your Hachiman space bar.`
              : 'Already a member? Your guilds are in your Hachiman space bar.'}
          </li>
        </ul>
      </div>

      <div className="flex gap-2.5">
        <Button asChild variant="secondary" size="lg" className="flex-1">
          <a href={hachimanLinks().app}>
            <ArrowUpRightIcon aria-hidden />
            Open Hachiman
          </a>
        </Button>
        <Button asChild variant="quiet" size="lg">
          <Link href="/account">
            <UserRoundIcon aria-hidden />
            Your account
          </Link>
        </Button>
      </div>
    </AuthCard>
  )
}
