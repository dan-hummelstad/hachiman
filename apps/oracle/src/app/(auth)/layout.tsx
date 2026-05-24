import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { TakusenLogo } from '@/components/takusen-logo'
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
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <TakusenLogo className="text-base" />
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  )
}
