import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  DownloadIcon,
  GlobeIcon,
  KeyRoundIcon,
  MailWarningIcon,
  PencilIcon,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'

import { EntityAvatar } from '@/components/ui/avatar'
import { HachimanMark } from '@/components/takusen-logo'
import { Tag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** The profile row at the top of the overview (E1). */
export function IdentityCard({
  name,
  email,
  avatarUrl,
  admin,
  memberSince,
}: {
  name: string
  email: string
  avatarUrl: string | null
  admin: boolean
  memberSince: string
}): React.JSX.Element {
  return (
    <section
      aria-label="Your profile"
      className="flex flex-wrap items-center gap-[18px] border border-line-hairline bg-surface-panel p-5"
    >
      <EntityAvatar src={avatarUrl} name={name} email={email} size={64} tone="gold" />
      <div className="flex min-w-0 flex-1 basis-[220px] flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-[22px] leading-7 font-extrabold">{name || email}</span>
          {admin && <Tag tone="gold">Admin</Tag>}
        </div>
        <span className="text-sm font-medium text-text-tertiary">
          <span className="break-all">{email}</span> · member since {memberSince}
        </span>
      </div>
      <Button variant="secondary" asChild>
        <Link href="/account">
          <PencilIcon aria-hidden />
          Edit profile
        </Link>
      </Button>
    </section>
  )
}

interface SecurityRow {
  key: string
  icon: LucideIcon
  tone: string
  title: string
  meta: string
  action?: React.ReactNode
}

/** Security (E1): the email state, the password age, and the pointer to Hachiman for device keys. */
export function SecurityPanel({
  email,
  emailVerified,
  passwordLine,
  showDeviceKeys,
  hachimanWeb,
}: {
  email: string
  emailVerified: boolean
  /** "Changed 12 days ago", "Set today". */
  passwordLine: string
  /** Only once the user has used Hachiman: before that there are no device keys. */
  showDeviceKeys: boolean
  hachimanWeb: string
}): React.JSX.Element {
  const rows: SecurityRow[] = [
    emailVerified
      ? { key: 'email', icon: CircleCheckIcon, tone: 'text-feature-voice-text', title: 'Email verified', meta: email }
      : // No email transport exists yet, so there is no "Resend": the row only states the fact.
        { key: 'email', icon: MailWarningIcon, tone: 'text-feature-event-text', title: 'Email not verified', meta: email },
    {
      key: 'password',
      icon: CircleCheckIcon,
      tone: 'text-feature-voice-text',
      title: 'Password',
      meta: passwordLine,
      action: (
        <Button variant="secondary" size="sm" asChild className="h-[30px]">
          <Link href="/account">Change</Link>
        </Button>
      ),
    },
  ]
  if (showDeviceKeys) {
    rows.push({
      key: 'keys',
      icon: KeyRoundIcon,
      tone: 'text-accent-text',
      title: 'Device keys live in Hachiman',
      meta: 'Devices and your recovery key are managed in the app.',
      action: (
        <Button variant="secondary" size="sm" asChild className="h-[30px]">
          <a href={hachimanWeb} target="_blank" rel="noreferrer">
            Open
          </a>
        </Button>
      ),
    })
  }

  return (
    <Panel>
      <PanelHeader title="Security" />
      <ul className="flex flex-col px-[18px] py-1.5">
        {rows.map((r, i) => {
          const Icon = r.icon
          return (
            <li key={r.key} className={cn('flex items-center gap-3 py-3', i > 0 && 'border-t border-line-hairline')}>
              <Icon aria-hidden className={cn('size-[18px] shrink-0', r.tone)} />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="text-sm leading-[18px] font-extrabold">{r.title}</span>
                <span className="text-[12.5px] leading-[17px] font-medium break-words text-text-tertiary">{r.meta}</span>
              </div>
              {r.action}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

export type StepState = 'done' | 'next' | 'todo'

const STEP_ICON: Record<StepState, { icon: LucideIcon; className: string }> = {
  done: { icon: CircleCheckIcon, className: 'text-feature-voice-text' },
  next: { icon: CircleDashedIcon, className: 'text-gold-text' },
  todo: { icon: CircleIcon, className: 'text-text-disabled' },
}

/** First visit (E3): the one next step, opening Hachiman, with the checklist beside it. */
export function NextStepPanel({
  downloadHref,
  webHref,
  steps,
}: {
  downloadHref: string
  webHref: string
  steps: { title: string; meta: string; state: StepState }[]
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="next-step-title"
      className="flex flex-col border border-line-hairline bg-surface-panel xl:flex-row"
    >
      <div className="flex min-w-0 flex-1 gap-5 bg-linear-180 from-wash to-surface-window to-60% p-5 sm:p-7">
        <HachimanMark size={64} className="max-sm:hidden" />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <h2 id="next-step-title" className="text-[22px] leading-7 font-extrabold">
            Next: open Hachiman
          </h2>
          <p className="text-[15px] leading-normal font-medium text-text-secondary">
            Sign in there with this account. Takusen asks once, then remembers.
          </p>
          <div className="flex flex-wrap gap-2.5 pt-1.5">
            <Button asChild>
              <a href={downloadHref}>
                <DownloadIcon aria-hidden />
                Download for desktop
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={webHref} target="_blank" rel="noreferrer">
                <GlobeIcon aria-hidden />
                Open in browser
              </a>
            </Button>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-3.5 border-line-hairline p-5 max-xl:border-t sm:p-7 xl:w-[360px] xl:border-l">
        <h3 className="section-label">Getting started</h3>
        <ol className="flex flex-col gap-3.5">
          {steps.map((s) => {
            const { icon: Icon, className } = STEP_ICON[s.state]
            return (
              <li key={s.title} className="flex gap-2.5">
                <Icon aria-hidden className={cn('mt-px size-[18px] shrink-0', className)} />
                <div className="flex flex-col gap-0.5">
                  <span
                    className={cn(
                      'text-sm leading-[18px] font-bold',
                      s.state === 'done' ? 'text-text-tertiary' : 'text-text-primary',
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="text-[12.5px] font-medium text-text-tertiary">{s.meta}</span>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
