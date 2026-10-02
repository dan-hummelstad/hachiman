import Link from 'next/link'
import {
  CheckIcon,
  GlobeIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
} from 'lucide-react'

import { TakusenLogo } from '@/components/takusen-logo'
import { Window } from '@/components/window'
import { Button } from '@/components/ui/button'
import { getOptionalUser } from '@/lib/auth-helpers'

const features = [
  {
    icon: KeyRoundIcon,
    title: 'Single sign-on',
    body: 'One Takusen account signs you in to Hachiman on desktop and in the browser.',
  },
  {
    icon: GlobeIcon,
    title: 'Regional voice',
    body: 'Voice runs on media nodes in the region closest to your guild.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Roles and permissions',
    body: 'Guild owners control who can see, speak, and moderate with roles and channel overwrites.',
  },
  {
    icon: UsersRoundIcon,
    title: 'Frictionless invites',
    body: 'Short invite codes open straight into the Hachiman app or the web client.',
  },
]

/** A static button look for the illustration (not focusable, not a control). */
function FakeButton({
  children,
  primary,
}: {
  children: React.ReactNode
  primary?: boolean
}): React.JSX.Element {
  return (
    <span
      className={
        primary
          ? 'flex h-8 items-center justify-center bg-primary px-3 text-sm font-medium text-primary-foreground'
          : 'flex h-8 items-center justify-center border px-3 text-sm font-medium'
      }
    >
      {children}
    </span>
  )
}

/**
 * The sign-in flow drawn as two old-messenger windows on a small desktop: the Hachiman
 * sign-in window behind, the Takusen consent window in front. Decorative only.
 */
function FlowIllustration(): React.JSX.Element {
  return (
    <div
      aria-hidden
      inert
      className="relative flex items-center justify-center overflow-hidden border bg-rail p-6 select-none sm:min-h-[420px]"
    >
      <Window
        as="h2"
        title="Sign in to Hachiman"
        className="absolute top-6 left-6 hidden max-w-[300px] sm:block"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center bg-primary text-lg font-semibold text-primary-foreground">
            H
          </span>
          <p className="text-sm">Hachiman uses your Takusen account.</p>
        </div>
        <FakeButton primary>Sign in with Takusen</FakeButton>
      </Window>

      <Window
        as="h2"
        title="Authorize Hachiman"
        className="relative max-w-[320px] sm:absolute sm:right-6 sm:bottom-6"
        footer={
          <div className="flex justify-end gap-2">
            <FakeButton>Deny</FakeButton>
            <FakeButton primary>Allow</FakeButton>
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center bg-primary text-xs font-semibold text-primary-foreground">
            AK
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">Aiko</span>
            <span className="text-xs leading-4 text-muted-foreground">aiko@example.com</span>
          </div>
        </div>
        <ul className="flex flex-col border">
          {['Confirm your identity', 'Read your display name', 'Stay signed in'].map((s) => (
            <li key={s} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
              <CheckIcon className="size-4 shrink-0 text-online" />
              {s}
            </li>
          ))}
        </ul>
      </Window>
    </div>
  )
}

export default async function MarketingHomePage(): Promise<React.JSX.Element> {
  const session = await getOptionalUser()

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b bg-sidebar">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
          <Link href="/" aria-label="Takusen home">
            <TakusenLogo />
          </Link>
          <nav aria-label="Account" className="flex items-center gap-2">
            {session ? (
              <Button asChild size="sm">
                <Link href="/dashboard">Go to dashboard</Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/login">Sign in</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href="/signup">Create account</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,540px)] lg:gap-14 lg:py-24">
          <div className="flex flex-col items-start gap-6">
            <h1 className="text-[34px] leading-[40px] font-semibold tracking-[-0.01em] sm:text-5xl sm:leading-[56px]">
              One account.
              <br />
              Every guild.
            </h1>
            <p className="max-w-[52ch] text-base leading-6 text-muted-foreground">
              Takusen is the identity provider behind Hachiman. Sign in once, hop between
              guilds, and prove who you are without juggling passwords.
            </p>
            <div className="flex flex-wrap gap-2">
              {session ? (
                <Button asChild size="lg">
                  <Link href="/dashboard">Open dashboard</Link>
                </Button>
              ) : (
                <>
                  <Button asChild size="lg">
                    <Link href="/signup">Create an account</Link>
                  </Button>
                  <Button asChild size="lg" variant="outline">
                    <Link href="/login">Sign in</Link>
                  </Button>
                </>
              )}
            </div>
          </div>
          <FlowIllustration />
        </section>

        <section aria-labelledby="features-title" className="border-t bg-sidebar">
          <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
            <h2 id="features-title" className="mb-6 text-[15px] leading-5 font-semibold">
              What your account covers
            </h2>
            <ul className="grid grid-cols-1 border bg-background sm:grid-cols-2 lg:grid-cols-4">
              {features.map((feature, i) => (
                <li
                  key={feature.title}
                  className={
                    'flex flex-col gap-2 p-5 ' +
                    // 1px rules between cells, whatever the column count.
                    (i > 0 ? 'border-t ' : '') +
                    (i % 2 === 1 ? 'sm:border-l ' : '') +
                    (i < 2 ? 'sm:border-t-0 ' : '') +
                    (i > 0 ? 'lg:border-t-0 lg:border-l' : '')
                  }
                >
                  <feature.icon aria-hidden className="size-5 text-primary" />
                  <h3 className="text-sm font-semibold">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col justify-between gap-1 px-4 py-5 text-xs leading-4 text-muted-foreground sm:flex-row sm:px-6">
          <span>&copy; {new Date().getFullYear()} Hachiman</span>
          <span>Takusen identity service</span>
        </div>
      </footer>
    </div>
  )
}
