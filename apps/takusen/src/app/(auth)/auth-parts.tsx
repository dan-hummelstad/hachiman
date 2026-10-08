import { CircleAlertIcon, CircleCheckIcon, CircleIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { passwordStrength } from '@/lib/password-strength'
import { cn } from '@/lib/utils'

/** The 44px gold tile above a recovery card's title: says what the page is about. */
export function IconTile({ icon: Icon }: { icon: LucideIcon }): React.JSX.Element {
  return (
    <div aria-hidden className="flex size-11 shrink-0 items-center justify-center bg-gold-tint text-gold-text">
      <Icon className="size-5" />
    </div>
  )
}

/** An AuthCard footer band with an icon and one quiet sentence. */
export function CardNote({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-[13.5px] leading-5 text-text-secondary">
      <Icon aria-hidden className="size-[15px] shrink-0 text-text-tertiary" />
      {children}
    </p>
  )
}

export function FormError({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

const TONE = {
  Weak: { bar: 'bg-feature-danger', text: 'text-feature-danger-text' },
  Fair: { bar: 'bg-feature-event', text: 'text-feature-event-text' },
  Good: { bar: 'bg-feature-voice', text: 'text-feature-voice-text' },
  Strong: { bar: 'bg-feature-voice', text: 'text-feature-voice-text' },
} as const

/**
 * Live feedback under a new password: four square bars, a word, and the rules ticking.
 * `common` always lists the "Not common" rule; otherwise it shows up only once it fails.
 */
export function PasswordMeter({
  id,
  password,
  email,
  common = false,
}: {
  id: string
  password: string
  email: string
  common?: boolean
}): React.JSX.Element {
  const { checks, score, label } = passwordStrength(password, email)
  const typed = password.length > 0
  const level = score > 0 ? { word: label, ...TONE[label] } : null
  return (
    <div id={id} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <div aria-hidden className="flex flex-1 items-center gap-1">
          {[1, 2, 3, 4].map((bar) => (
            <span
              key={bar}
              className={cn('h-1 flex-1', level && bar <= score ? level.bar : 'bg-surface-raised')}
            />
          ))}
        </div>
        <span aria-live="polite" className={cn('text-right text-[12.5px] leading-4 font-extrabold', level?.text)}>
          {level && (
            <>
              <span className="sr-only">Password strength: </span>
              {level.word}
            </>
          )}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        <Requirement met={typed && checks.length}>8+ characters</Requirement>
        <Requirement met={typed && checks.notEmail}>Not your email</Requirement>
        {(common || !checks.notCommon) && <Requirement met={typed && checks.notCommon}>Not common</Requirement>}
      </ul>
    </div>
  )
}

function Requirement({ met, children }: { met: boolean; children: ReactNode }): React.JSX.Element {
  const Icon = met ? CircleCheckIcon : CircleIcon
  return (
    <li className="flex items-center gap-1.5 text-[12.5px] leading-4 font-semibold text-text-secondary">
      <Icon aria-hidden className={cn('size-3.5', met ? 'text-feature-voice-text' : 'text-text-disabled')} />
      {children}
      <span className="sr-only">{met ? '(met)' : '(not met)'}</span>
    </li>
  )
}
