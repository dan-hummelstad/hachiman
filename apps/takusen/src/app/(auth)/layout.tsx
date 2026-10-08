import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { getOptionalUser } from '@/lib/auth-helpers'

// Each page renders its own AuthScreen: only the page knows whether an app sent the visitor.
export default async function AuthLayout({
  children,
}: {
  children: ReactNode
}): Promise<React.JSX.Element> {
  const session = await getOptionalUser()
  if (session) {
    redirect('/dashboard')
  }
  return <>{children}</>
}
