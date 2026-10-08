'use client'

import { AppWindowIcon, GlobeIcon, InfoIcon, LogOutIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react'

import { useRouter } from 'next/navigation'

import { signOutEverywhereElseAction, signOutHachimanSessionAction, revokeAppAccessAction } from '@/app/(dashboard)/dashboard/actions'
import { ConfirmButton, useResultAction } from '@/components/account/confirm-button'
import { plural } from '@/components/account/format'
import { Tag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader, PanelList } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type SessionIcon = 'desktop' | 'web' | 'phone' | 'app'

const ICONS = { desktop: MonitorIcon, web: GlobeIcon, phone: SmartphoneIcon, app: AppWindowIcon }

/** A Hachiman sign-in, labelled on the server. */
export interface SessionRowData {
  grantId: string
  icon: SessionIcon
  title: string
  meta: string
}

function DeviceTile({ icon }: { icon: SessionIcon }): React.JSX.Element {
  const Icon = ICONS[icon]
  return (
    <span className="flex size-[38px] shrink-0 items-center justify-center border border-line-hairline bg-surface-raised">
      <Icon aria-hidden className="size-[18px] text-text-secondary" />
    </span>
  )
}

function SessionText({
  title,
  tags,
  meta,
}: {
  title: string
  tags: React.ReactNode
  meta: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-[14.5px] leading-5 font-extrabold">{title}</span>
        {tags}
      </div>
      <span className="text-[13px] leading-[18px] font-medium text-text-tertiary">{meta}</span>
    </div>
  )
}

/** "Where you're signed in": this browser (the dashboard cookie), then every Hachiman sign-in. */
export function SessionsPanel({
  browser,
  sessions,
}: {
  browser: { label: string; mobile: boolean }
  sessions: SessionRowData[]
}): React.JSX.Element {
  const router = useRouter()
  const { pending, run } = useResultAction()
  const total = sessions.length + 1

  return (
    <Panel aria-labelledby="sessions-title">
      <PanelHeader title={<span id="sessions-title">Where you&apos;re signed in</span>} meta={plural(total, 'session', 'sessions')} />
      <PanelList>
        <li className="flex items-center gap-3.5 rounded-control p-3">
          <DeviceTile icon={browser.mobile ? 'phone' : 'web'} />
          <SessionText
            title={browser.label}
            tags={
              <>
                <Tag tone="gold">Takusen</Tag>
                <Tag>This browser</Tag>
              </>
            }
            meta="active now"
          />
        </li>
        {sessions.map((s) => (
          <li
            key={s.grantId}
            className="group flex items-center gap-3.5 rounded-control p-3 transition-colors focus-within:bg-surface-hover hover:bg-surface-hover"
          >
            <DeviceTile icon={s.icon} />
            <SessionText title={s.title} tags={<Tag tone="hachiman">Hachiman</Tag>} meta={s.meta} />
            <Button
              variant="quiet"
              size="sm"
              disabled={pending}
              aria-label={`Sign out ${s.title}, ${s.meta}`}
              onClick={() => run(() => signOutHachimanSessionAction(s.grantId), `Signed out ${s.title}`)}
              className="group-focus-within:border-feature-danger/25 group-focus-within:bg-feature-danger/10 group-focus-within:text-feature-danger-text group-hover:border-feature-danger/25 group-hover:bg-feature-danger/10 group-hover:text-feature-danger-text [&_svg]:hidden group-focus-within:[&_svg]:block group-focus-within:[&_svg]:text-feature-danger-text group-hover:[&_svg]:block group-hover:[&_svg]:text-feature-danger-text"
            >
              <LogOutIcon aria-hidden />
              Sign out
            </Button>
          </li>
        ))}
      </PanelList>
      {sessions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line-hairline px-[18px] py-3">
          <p className="min-w-0 flex-1 basis-[220px] text-[13px] font-medium text-text-tertiary">
            Ends {plural(sessions.length, 'session', 'sessions')}. You stay signed in here.
          </p>
          <ConfirmButton
            trigger={(open) => (
              <Button variant="danger-soft" size="sm" onClick={open}>
                <LogOutIcon aria-hidden />
                Sign out everywhere else
              </Button>
            )}
            title="Sign out everywhere else?"
            body={`This ends ${plural(sessions.length, 'Hachiman session', 'Hachiman sessions')} and every other browser signed in to Takusen. Your devices and keys stay. You stay signed in here.`}
            confirmLabel="Sign out everywhere else"
            done="Signed out everywhere else"
            action={signOutEverywhereElseAction}
            onDone={() => router.refresh()}
          />
        </div>
      ) : (
        <p className="flex items-center gap-2.5 border-t border-line-hairline px-[18px] py-3.5 text-[13px] font-medium text-text-tertiary">
          <InfoIcon aria-hidden className="size-[15px] shrink-0" />
          Hachiman sessions show up here once you sign in to the app.
        </p>
      )}
    </Panel>
  )
}

export interface AppRowData {
  clientId: string
  meta: string
  sessionCount: number
}

/** "Apps with access": one row per OIDC client with a live grant. */
export function AppsPanel({ apps }: { apps: AppRowData[] }): React.JSX.Element {
  return (
    <Panel aria-labelledby="apps-title">
      <PanelHeader title={<span id="apps-title">Apps with access</span>} />
      {apps.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-[18px] py-[22px] text-center">
          <AppWindowIcon aria-hidden className="size-[22px] text-text-disabled" />
          <span className="text-sm font-extrabold text-text-secondary">No apps yet</span>
          <span className="text-[12.5px] font-medium text-text-tertiary">
            Apps you allow, like Hachiman, appear here.
          </span>
        </div>
      ) : (
        <ul className="flex flex-col">
          {apps.map((a, i) => (
            <li
              key={a.clientId}
              className={cn('flex items-center gap-3 px-[18px] py-3.5', i > 0 && 'border-t border-line-hairline')}
            >
              <DeviceTile icon="app" />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="truncate font-mono text-[13.5px] leading-5 font-semibold">{a.clientId}</span>
                <span className="text-[12.5px] font-medium text-text-tertiary">{a.meta}</span>
              </div>
              <ConfirmButton
                trigger={(open) => (
                  <Button variant="quiet" size="sm" onClick={open} className="text-feature-danger-text hover:text-feature-danger-text">
                    Revoke
                  </Button>
                )}
                title="Revoke access?"
                body={`${a.clientId} can no longer use your account. This ends ${plural(a.sessionCount, 'session', 'sessions')}; sign in again in the app to give it access. Your devices and keys stay.`}
                confirmLabel="Revoke access"
                done={`Revoked access for ${a.clientId}`}
                action={() => revokeAppAccessAction(a.clientId)}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
