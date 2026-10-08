/**
 * OIDC interaction page — the consent / "continue as" screen the user sees
 * when a relying party (e.g. the Hachiman app) starts an
 * authorization request and the OP needs explicit user action.
 *
 * Mounted at `/oidc/interaction/[uid]` — NOT under /api, because we want
 * the normal Next.js page lifecycle (Auth.js session read, server actions).
 */
import { redirect } from 'next/navigation'
import {
  AppWindowIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CornerDownLeftIcon,
  IdCardIcon,
  KeyRoundIcon,
  MailIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  type LucideIcon,
} from 'lucide-react'

import { AuthCard, AuthScreen } from '@/components/auth-frame'
import { HandoffRail } from '@/components/handoff-rail'
import { AccountChip, SwitchAccountButton, UserAvatar, type SsoAccount } from '@/components/sso-account'
import { TakusenMark } from '@/components/takusen-logo'
import { Tag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { auth } from '@/auth'
import { getAccountSummary } from '@/lib/account'
import { consentRequest } from '@/lib/oidc-consent'
import { getInteraction } from '@/lib/oidc-interaction'

import {
  acceptInteractionAction,
  denyInteractionAction,
  describeClient,
} from './actions'

interface PageProps {
  params: Promise<{ uid: string }>
}

/** Each known scope as a sentence; `short` is the phone copy (H3). */
const SCOPES: Record<
  string,
  { icon: LucideIcon; title: string; detail: string; short?: { title?: string; detail: string } }
> = {
  openid: {
    icon: IdCardIcon,
    title: "Confirm it's you",
    detail: "Your account ID, so it knows it's you.",
    short: { detail: 'Your account ID.' },
  },
  profile: {
    icon: UserRoundIcon,
    title: 'See your display name and avatar',
    detail: 'Shown to people in your guilds.',
    short: { title: 'See your name and avatar', detail: 'Shown in your guilds.' },
  },
  email: {
    icon: MailIcon,
    title: 'See your email address',
    detail: 'For alerts only. Never shown to others.',
    short: { detail: 'Never shown to others.' },
  },
  offline_access: {
    icon: RefreshCwIcon,
    title: 'Keep you signed in',
    detail: 'Refreshes your session without asking.',
    short: { detail: 'No asking again.' },
  },
}

/** The desktop copy, or below `sm` the shorter phone copy when there is one. */
function Responsive({ wide, narrow }: { wide: string; narrow?: string }): React.JSX.Element {
  if (!narrow || narrow === wide) return <>{wide}</>
  return (
    <>
      <span className="max-sm:hidden">{wide}</span>
      <span className="sm:hidden">{narrow}</span>
    </>
  )
}

export default async function InteractionPage({ params }: PageProps) {
  const { uid } = await params
  const session = await auth()

  // Validate the interaction up front. If the cookie is missing / expired,
  // `getInteraction` will throw — let Next render the default error page.
  const { interaction } = await getInteraction(uid)

  // No session → kick to /login with a `next` that returns the browser here.
  const here = `/oidc/interaction/${uid}`
  if (!session?.user?.id) {
    redirect(`/login?next=${encodeURIComponent(here)}`)
  }

  const request = consentRequest(interaction)
  const [clientInfo, summary] = await Promise.all([
    request.clientId ? describeClient(request.clientId) : null,
    getAccountSummary(session.user.id),
  ])
  const clientName = clientInfo?.name ?? (request.clientId || 'An unknown application')

  // Bind the server actions to this interaction's uid so the form can call
  // them without a hidden input.
  const accept = acceptInteractionAction.bind(null, uid)
  const deny = denyInteractionAction.bind(null, uid)

  const account: SsoAccount = {
    name: session.user.name ?? '',
    email: session.user.email ?? '',
    avatarUrl: summary?.avatarUrl ?? null,
  }
  const accountLabel = account.name || account.email
  const isLogin = request.prompt === 'login'

  const redirectLine = request.redirectUri && (
    <p className="flex min-w-0 items-center gap-2 text-[12.5px] leading-4 font-medium text-text-tertiary">
      <CornerDownLeftIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">Returns to</span>
      <code className="truncate font-mono text-xs text-text-secondary">{request.redirectUri}</code>
    </p>
  )

  return (
    <AuthScreen
      className="max-w-[532px]"
      topBarEnd={<AccountChip account={account} />}
      rail={
        <HandoffRail
          steps={[
            { product: 'hachiman', label: 'Hachiman', state: 'done' },
            { product: 'takusen', label: isLogin ? 'Continue' : 'Allow access', state: 'current' },
            { product: 'hachiman', label: 'Back to Hachiman', state: 'next' },
          ]}
        />
      }
    >
      <AuthCard
        className="sm:max-w-[500px]"
        bodyClassName="sm:gap-[18px] sm:px-8 sm:pt-[26px] sm:pb-[22px]"
        footerClassName="max-sm:sticky max-sm:bottom-0 max-sm:flex-col max-sm:items-stretch max-sm:gap-2.5 max-sm:pb-5 sm:flex-row-reverse sm:gap-2.5 sm:px-5 sm:py-3.5"
        media={
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex size-11 items-center justify-center border border-line-strong bg-surface-raised text-text-secondary"
            >
              <AppWindowIcon className="size-[22px]" />
            </span>
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-full border border-line-strong bg-surface-raised text-text-secondary"
            >
              <ArrowLeftRightIcon className="size-3.5" />
            </span>
            <TakusenMark size={44} />
          </div>
        }
        title={
          <span className="text-[22px] leading-[1.25] tracking-[-0.3px]">
            {isLogin ? (
              <>Continue as {accountLabel}?</>
            ) : (
              <>
                Allow <span className="break-all">{clientName}</span> to use your account?
              </>
            )}
          </span>
        }
        footer={
          <>
            {redirectLine && <div className="flex justify-center sm:hidden">{redirectLine}</div>}
            <form action={accept} className="max-sm:w-full">
              <Button type="submit" className="w-full sm:h-10" size="default">
                <ArrowRightIcon aria-hidden />
                <span className="truncate">Continue as {accountLabel}</span>
              </Button>
            </form>
            <form action={deny} className="max-sm:w-full">
              <Button type="submit" variant="quiet" className="w-full">
                Cancel
              </Button>
            </form>
          </>
        }
      >
        <div className="-mt-2 flex flex-wrap items-center gap-2 max-sm:hidden">
          <code className="font-mono text-[12.5px] font-medium text-text-tertiary">{request.clientId}</code>
          {request.pkce && <Tag tone="info">PKCE</Tag>}
          {clientInfo?.isPublic && <Tag tone="neutral">Public</Tag>}
        </div>

        <div className="flex items-center gap-3 border border-line-hairline bg-surface-raised p-3">
          <UserAvatar account={account} size={40} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[15px] leading-5 font-extrabold">{accountLabel}</span>
            {account.name && (
              <span className="truncate text-[13px] leading-4 font-medium text-text-tertiary">
                {account.email}
              </span>
            )}
          </div>
          <SwitchAccountButton next={here} />
        </div>

        {isLogin ? (
          <p className="text-body text-text-secondary">
            <span className="font-mono text-sm text-text-primary">{clientName}</span> would like to
            know who you are.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <h2 className="section-label">It will be able to</h2>
            {request.scopes.length === 0 ? (
              <p className="py-2 text-sm text-text-tertiary">No scopes requested.</p>
            ) : (
              <ul className="flex flex-col">
                {request.scopes.map((scope) => {
                  const known = SCOPES[scope]
                  const Icon = known?.icon ?? KeyRoundIcon
                  return (
                    <li
                      key={scope}
                      className="flex items-center gap-3.5 border-b border-line-hairline py-[9px] last:border-b-0"
                    >
                      <span
                        aria-hidden
                        className="flex size-[34px] shrink-0 items-center justify-center bg-surface-raised text-gold-text"
                      >
                        <Icon className="size-[17px]" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-[14.5px] leading-5 font-bold text-text-primary">
                          {known ? <Responsive wide={known.title} narrow={known.short?.title} /> : scope}
                        </span>
                        {known && (
                          <span className="text-[13px] leading-[1.4] font-medium text-text-tertiary">
                            <Responsive wide={known.detail} narrow={known.short?.detail} />
                          </span>
                        )}
                      </span>
                      <code className="shrink-0 font-mono text-[11.5px] text-text-tertiary">{scope}</code>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-3 border-l-[3px] border-gold bg-surface-raised px-3.5 py-3">
          <ShieldCheckIcon aria-hidden className="mt-0.5 size-[17px] shrink-0 text-gold-text" />
          <p className="text-[13.5px] leading-[1.45] font-medium text-text-secondary">
            <Responsive
              wide="It can't see your password, and Takusen can't read your messages: Hachiman encrypts them on your devices."
              narrow="It can't see your password or your messages."
            />
          </p>
        </div>

        {redirectLine && <div className="max-sm:hidden">{redirectLine}</div>}
      </AuthCard>
    </AuthScreen>
  )
}
