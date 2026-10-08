import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  BadgeCheckIcon,
  BanIcon,
  BirdIcon,
  IdCardIcon,
  LockIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  UserRoundIcon,
  type LucideIcon,
} from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

import { Container } from '@/components/marketing/band'
import { Brand, HachimanMark, TakusenMark } from '@/components/takusen-logo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface NavLink {
  label: string
  href: string
}

/** The landing top bar: links inline from `md`, a menu below it. */
function LandingNav({ links, signedIn }: { links: NavLink[]; signedIn: boolean }): React.JSX.Element {
  return (
    <header className="sm:border-b sm:border-line-hairline">
      <Container className="flex h-[52px] items-center gap-8 px-4 sm:h-[76px]">
        <Link href="/" aria-label="Takusen home" className="rounded-control">
          <Brand />
        </Link>
        <nav aria-label="Takusen" className="flex items-center gap-7 pl-6 max-md:hidden">
          {links.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-[14.5px] leading-5 font-bold text-text-secondary hover:text-text-primary"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 max-sm:hidden">
          {signedIn ? (
            <Button asChild className="h-10">
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="quiet" className="h-10">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild className="h-10">
                <Link href="/signup">Create account</Link>
              </Button>
            </>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="quiet" size="icon-lg" aria-label="Menu" className="ml-auto sm:ml-0 md:hidden">
              <MenuIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {links.map((l) => (
              <DropdownMenuItem key={l.label} asChild>
                <Link href={l.href}>{l.label}</Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="sm:hidden" />
            {signedIn ? (
              <DropdownMenuItem asChild className="sm:hidden">
                <Link href="/dashboard">Go to dashboard</Link>
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem asChild className="sm:hidden">
                  <Link href="/login">Sign in</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="sm:hidden">
                  <Link href="/signup">Create account</Link>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Container>
    </header>
  )
}

const TRUST: { icon: LucideIcon; label: string }[] = [
  { icon: BadgeCheckIcon, label: 'Free for every guild' },
  { icon: LockIcon, label: 'End-to-end encrypted' },
  { icon: BanIcon, label: 'No ads, no tracking' },
]

/** Hachiman as it really looks: a screenshot of the app, one per theme. */
function ProductShot({ className }: { className?: string }): React.JSX.Element {
  const alt = 'The Hachiman app: a guild text channel with its members, voice and pages'
  const img = { width: 1472, height: 920, priority: true, unoptimized: true } as const
  return (
    <div className={`border border-line-strong shadow-card ${className ?? ''}`}>
      <Image src="/hachiman-dark.webp" alt={alt} {...img} className="hidden h-auto w-full dark:block" />
      <Image src="/hachiman-light.webp" alt={alt} {...img} className="block h-auto w-full dark:hidden" />
    </div>
  )
}

const SCOPES: { icon: LucideIcon; label: string }[] = [
  { icon: IdCardIcon, label: "Confirm it's you" },
  { icon: UserRoundIcon, label: 'See your display name' },
  { icon: RefreshCwIcon, label: 'Keep you signed in' },
]

/** The Takusen consent card laid over the screenshot. A picture: not focusable, no controls. */
function ConsentMock({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden
      inert
      className={`w-[330px] border border-line-strong bg-surface-card shadow-card select-none ${className ?? ''}`}
    >
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="flex items-center gap-2">
          <HachimanMark size={28} />
          <span className="flex size-5 items-center justify-center rounded-full border border-line-strong bg-surface-raised">
            <ArrowLeftRightIcon className="size-2.5 text-text-secondary" />
          </span>
          <TakusenMark size={28} />
        </div>
        <p className="text-[15.5px] leading-[1.25] font-extrabold text-text-primary">
          Allow Hachiman to use your account?
        </p>
        <div className="flex items-center gap-[9px] border border-line-hairline bg-surface-raised p-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-[#6f8bff]">
            <BirdIcon className="size-[15px] text-[#14151c]" />
          </span>
          <span className="flex flex-col gap-px">
            <span className="text-[13px] leading-4 font-extrabold text-text-primary">kestrel</span>
            <span className="text-[11.5px] leading-[14px] font-medium text-text-tertiary">
              kestrel@example.com
            </span>
          </span>
        </div>
        {SCOPES.map((s) => (
          <div key={s.label} className="flex items-center gap-[9px]">
            <span className="flex size-6 items-center justify-center bg-surface-raised">
              <s.icon className="size-[13px] text-gold-text" />
            </span>
            <span className="text-[12.5px] leading-4 font-bold text-text-secondary">{s.label}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 border-t border-line-hairline bg-surface-panel px-3 py-2.5">
        <span className="flex h-[30px] items-center rounded-control px-3 text-[12.5px] font-extrabold text-text-secondary">
          Cancel
        </span>
        <span className="flex h-[30px] items-center rounded-control bg-gold px-3 text-[12.5px] font-extrabold text-on-gold">
          Continue as kestrel
        </span>
      </div>
    </div>
  )
}

export function LandingHero({
  links,
  signedIn,
}: {
  links: NavLink[]
  signedIn: boolean
}): React.JSX.Element {
  return (
    <div className="relative isolate overflow-hidden bg-[linear-gradient(180deg,var(--wash)_0%,var(--surface-window)_60%)]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 mx-auto h-full max-w-[1440px]">
        <div className="absolute -top-[260px] -left-[160px] h-[620px] w-[700px] rounded-full bg-[radial-gradient(closest-side,var(--glow),var(--glow-0))] sm:-top-[420px] sm:-left-[200px] sm:h-[1000px] sm:w-[1200px]" />
        <div className="absolute -top-[260px] left-[760px] h-[800px] w-[900px] rounded-full bg-[radial-gradient(closest-side,#7b6cff24,#7b6cff00)] max-lg:hidden" />
      </div>

      <LandingNav links={links} signedIn={signedIn} />

      <Container className="flex flex-col gap-8 pt-6 pb-8 lg:flex-row lg:items-center lg:gap-16 lg:pt-[88px] lg:pb-24">
        <div className="flex flex-col gap-[18px] sm:gap-7 lg:w-[540px] lg:shrink-0">
          <p className="flex items-center gap-2 sm:gap-2.5">
            <HachimanMark size={22} className="max-sm:size-[18px]! max-sm:text-[10px]!" />
            <PlusIcon aria-hidden className="size-3 text-text-tertiary max-sm:hidden" />
            <TakusenMark size={22} className="max-sm:size-[18px]! max-sm:text-[10px]!" />
            <span className="text-[11px] leading-4 font-extrabold tracking-[1px] text-gold-text uppercase sm:text-[12.5px] sm:tracking-[1.2px]">
              The account behind Hachiman
            </span>
          </p>
          <h1 className="text-[44px] leading-[1.02] font-extrabold tracking-[-1.4px] text-text-primary sm:text-[78px] sm:tracking-[-2.6px]">
            One account.
            <br />
            Every guild.
          </h1>
          <p className="text-base leading-[1.5] font-medium text-text-secondary sm:text-[19px] sm:leading-[1.55]">
            Takusen is the identity behind Hachiman. Sign in once, hop between guilds, and prove
            who you are without juggling passwords.
          </p>
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
            {signedIn ? (
              <Button asChild size="xl" className="sm:h-[50px] sm:px-[22px] sm:text-[15.5px]">
                <Link href="/dashboard">
                  <ArrowRightIcon aria-hidden />
                  Open dashboard
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild size="xl" className="sm:h-[50px] sm:px-[22px] sm:text-[15.5px]">
                  <Link href="/signup">
                    <ArrowRightIcon aria-hidden />
                    Create an account
                  </Link>
                </Button>
                <Button
                  asChild
                  size="xl"
                  variant="secondary"
                  className="sm:h-[50px] sm:px-[22px] sm:text-[15.5px]"
                >
                  <Link href="/login">Sign in</Link>
                </Button>
              </>
            )}
          </div>
          <p className="text-[12.5px] leading-4 font-semibold text-text-tertiary sm:hidden">
            Free · End-to-end encrypted · No ads
          </p>
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 max-sm:hidden">
            {TRUST.map((t) => (
              <li
                key={t.label}
                className="flex items-center gap-[7px] text-[13.5px] leading-4 font-semibold text-text-tertiary"
              >
                <t.icon aria-hidden className="size-[15px] text-feature-voice-text" />
                {t.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative min-w-0 lg:h-[540px] lg:flex-1">
          <ProductShot className="lg:absolute lg:top-0 lg:left-14 lg:w-[736px]" />
          <ConsentMock className="absolute top-[236px] left-0 max-lg:hidden" />
        </div>
      </Container>
    </div>
  )
}
