import type { ReactNode } from 'react'

import { AuthCard, AuthScreen } from '@/components/auth-frame'

// Older names for the SSO frame, kept until every page uses AuthScreen / AuthCard directly.

export interface WindowProps {
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  as?: 'h1' | 'h2'
  className?: string
  bodyClassName?: string
}

/** @deprecated Use `AuthCard` from `@/components/auth-frame`. */
export function Window({ title, children, footer, as, className, bodyClassName }: WindowProps): React.JSX.Element {
  return (
    <AuthCard title={title} footer={footer} as={as} className={className} bodyClassName={bodyClassName}>
      {children}
    </AuthCard>
  )
}

/** @deprecated Use `AuthScreen` from `@/components/auth-frame`. */
export function WindowScreen({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <AuthScreen className={className}>{children}</AuthScreen>
}
