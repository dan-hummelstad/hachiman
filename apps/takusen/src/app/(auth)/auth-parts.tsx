import { CircleAlertIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'

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
