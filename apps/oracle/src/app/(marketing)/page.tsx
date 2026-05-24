import Link from 'next/link'
import {
  GlobeIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
} from 'lucide-react'

import { TakusenLogo } from '@/components/takusen-logo'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { getOptionalUser } from '@/lib/auth-helpers'

const features = [
  {
    icon: KeyRoundIcon,
    title: 'Single sign-on',
    body: 'One Takusen account works across every Mumble server in the Hachiman ecosystem via OIDC.',
  },
  {
    icon: GlobeIcon,
    title: 'Server registry',
    body: 'Discoverable directory of community-run Mumble servers with verified domain ownership.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'DNS-verified ownership',
    body: 'Operators prove they control a domain before their server is listed — no impersonation.',
  },
  {
    icon: UsersRoundIcon,
    title: 'Frictionless invites',
    body: 'Short invite codes redeem into signed takusen:// URIs your client opens instantly.',
  },
]

export default async function MarketingHomePage(): Promise<React.JSX.Element> {
  const session = await getOptionalUser()

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <TakusenLogo className="text-base" />
          </Link>
          <nav aria-label="Marketing" className="flex items-center gap-2">
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
                  <Link href="/signup">Get started</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 px-4 py-20 text-center sm:px-6 lg:px-8 lg:py-28">
          <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            Identity for the Hachiman Mumble ecosystem
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            One account. Every server.
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground sm:text-lg">
            Takusen is the identity provider and server registry that ties the
            Hachiman Mumble ecosystem together. Sign in once, hop between
            community servers, and prove who you are without juggling
            passwords.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
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
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <Card key={feature.title} className="h-full">
                <CardHeader className="gap-3">
                  <feature.icon className="size-5 text-primary" />
                  <CardTitle className="text-base">{feature.title}</CardTitle>
                  <CardDescription>{feature.body}</CardDescription>
                </CardHeader>
                <CardContent />
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
          <span>&copy; {new Date().getFullYear()} Hachiman</span>
          <span>Takusen identity service</span>
        </div>
      </footer>
    </div>
  )
}
