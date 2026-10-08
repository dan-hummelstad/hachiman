import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { AuthScreen } from '@/components/auth-frame'
import { getOptionalUser } from '@/lib/auth-helpers'

export default async function AuthLayout({
  children,
}: {
  children: ReactNode
}): Promise<React.JSX.Element> {
  const session = await getOptionalUser()
  if (session) {
    redirect('/dashboard')
  }
  return <AuthScreen>{children}</AuthScreen>
}
