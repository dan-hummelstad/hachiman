import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  AudioLinesIcon,
  BirdIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  DownloadIcon,
  FileTextIcon,
  KeyRoundIcon,
  LifeBuoyIcon,
  LockIcon,
  LockKeyholeIcon,
  MailIcon,
  MessagesSquareIcon,
  MonitorSmartphoneIcon,
  ShieldCheckIcon,
  TicketIcon,
  UserRoundIcon,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { Band, BandTitle, Container, Fit, Kicker } from '@/components/marketing/band'
import { HachimanMark, TakusenMark } from '@/components/takusen-logo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { HachimanLinks } from '@/lib/deployment'
import { plural } from '@/lib/format'
import type { RegionStatus } from '@/lib/region-status'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// How sign-in works
// ---------------------------------------------------------------------------

/** The step pictures: static, not focusable, no controls. */
function Snippet({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      aria-hidden
      inert
      className="mt-auto flex h-[132px] items-center justify-center gap-3 border border-line-hairline bg-surface-panel select-none max-sm:hidden"
    >
      {children}
    </div>
  )
}

const STEPS: { title: string; body: string; short: string; picture: ReactNode }[] = [
  {
    title: 'Choose Sign in with Takusen',
    body: "Hachiman opens Takusen in your browser. The violet button is Hachiman's; everything gold after it is Takusen's.",
    short: 'Hachiman opens Takusen in your browser.',
    picture: (
      <span className="flex h-11 items-center gap-[7px] rounded-control bg-accent-primary px-4 text-sm font-extrabold text-white">
        <ArrowUpRightIcon className="size-[15px]" />
        Sign in with Takusen
      </span>
    ),
  },
  {
    title: 'Allow Hachiman, once',
    body: "Takusen shows exactly what Hachiman gets and which account you're using. Say yes and it remembers.",
    short: 'See exactly what it gets, then say yes.',
    picture: (
      <>
        <span className="flex h-[38px] items-center gap-2 rounded-full border border-line-hairline bg-surface-hover pr-3 pl-[5px]">
          <span className="flex size-7 items-center justify-center rounded-full bg-[#6f8bff]">
            <BirdIcon className="size-[15px] text-[#14151c]" />
          </span>
          <span className="text-sm font-extrabold text-text-primary">kestrel</span>
          <ChevronDownIcon className="size-[15px] text-text-tertiary" />
        </span>
        <span className="flex h-10 items-center rounded-control bg-gold px-3.5 text-sm font-extrabold text-on-gold">
          Continue as kestrel
        </span>
      </>
    ),
  },
  {
    title: 'Land back in your guilds',
    body: "Your browser hands you back to the app, signed in. Close the tab; you won't need it again.",
    short: 'Your browser hands you back, signed in.',
    picture: (
      <span className="flex w-[300px] items-center gap-3 border-l-[3px] border-feature-voice bg-surface-raised px-3.5 py-3 shadow-menu">
        <HachimanMark size={30} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm leading-[18px] font-extrabold text-text-primary">Signed in as kestrel</span>
          <span className="flex items-center gap-1.5 text-[12.5px] leading-4 font-medium text-text-tertiary">
            <span className="size-[7px] rounded-full bg-status-online" />
            Night Owls · 5 online
          </span>
        </span>
        <CircleCheckIcon className="size-[18px] text-feature-voice-text" />
      </span>
    ),
  },
]

export function HowItWorks(): React.JSX.Element {
  return (
    <Band id="how-it-works" labelledBy="how-title">
      <span id="help" className="sr-only" />
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-12">
        <div className="flex flex-1 flex-col gap-5 sm:gap-3.5">
          <Kicker>How sign-in works</Kicker>
          <BandTitle id="how-title">
            Sign in once. <br className="max-sm:hidden" />
            Come straight back.
          </BandTitle>
        </div>
        <p className="text-[16.5px] leading-[1.5] font-medium text-text-secondary max-sm:hidden sm:w-[460px]">
          Hachiman never sees your password. It sends you to Takusen, you say yes once, and you land
          back where you were.
        </p>
      </div>
      <ol className="grid sm:grid-cols-3 sm:border sm:border-line-hairline">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            className={cn(
              'flex flex-col gap-1.5 border-line-hairline max-sm:border-t max-sm:pt-3.5 sm:gap-3.5 sm:p-7 sm:not-first:border-l',
              'max-sm:not-last:pb-1.5',
            )}
          >
            <span className="font-mono text-[13px] leading-4 font-semibold text-gold-text sm:text-sm">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 className="text-[17px] leading-[22px] font-extrabold text-text-primary sm:text-[21px] sm:leading-[26px] sm:tracking-[-0.3px]">
              {s.title}
            </h3>
            <p className="text-sm leading-[1.5] font-medium text-text-secondary sm:mb-3.5 sm:text-[15px]">
              <Fit short={s.short} long={s.body} />
            </p>
            <Snippet>{s.picture}</Snippet>
          </li>
        ))}
      </ol>
    </Band>
  )
}

// ---------------------------------------------------------------------------
// What your account covers
// ---------------------------------------------------------------------------

const FEATURES: { icon: LucideIcon; tile: string; title: string; body: string; short: string }[] = [
  {
    icon: KeyRoundIcon,
    tile: 'bg-gold-tint text-gold-text',
    title: 'Single sign-on',
    body: 'One Takusen account signs you in to Hachiman on desktop, in the browser and on your phone.',
    short: 'One account for desktop, browser and phone.',
  },
  {
    icon: AudioLinesIcon,
    tile: 'bg-feature-voice/15 text-feature-voice-text',
    title: 'Regional voice',
    body: 'Voice runs on media nodes in the region closest to your guild, so calls stay quick.',
    short: 'Calls run in the region closest to your guild.',
  },
  {
    icon: ShieldCheckIcon,
    tile: 'bg-feature-thread/15 text-feature-thread-text',
    title: 'Roles and permissions',
    body: 'Guild owners decide who can see, speak and moderate, with roles and channel overrides.',
    short: 'Owners decide who can see, speak and moderate.',
  },
  {
    icon: TicketIcon,
    tile: 'bg-feature-page/15 text-feature-page-text',
    title: 'Invites that just open',
    body: "Short invite codes open straight into the Hachiman app, or the web client if you don't have it.",
    short: 'Short codes open straight into Hachiman.',
  },
]

export function Features(): React.JSX.Element {
  return (
    <Band labelledBy="features-title">
      <div className="flex flex-col gap-5 sm:gap-3.5">
        <Kicker>What your account covers</Kicker>
        <BandTitle id="features-title">
          <Fit
            short="Everything Hachiman needs. Nothing more."
            long={
              <>
                Everything Hachiman needs to know. <br />
                Nothing it doesn&apos;t.
              </>
            }
          />
        </BandTitle>
      </div>
      <ul className="grid gap-5 sm:grid-cols-2 sm:gap-0 sm:border sm:border-line-hairline lg:grid-cols-4">
        {FEATURES.map((f, i) => (
          <li
            key={f.title}
            className={cn(
              'flex gap-3.5 border-line-hairline sm:flex-col sm:p-7',
              i % 2 === 1 && 'sm:border-l',
              i >= 2 && 'sm:border-t lg:border-t-0',
              i === 2 && 'lg:border-l',
            )}
          >
            <span className={cn('flex size-10 shrink-0 items-center justify-center sm:size-[46px]', f.tile)}>
              <f.icon aria-hidden className="size-[18px] sm:size-[21px]" />
            </span>
            <div className="flex flex-col gap-1 sm:gap-3.5">
              <h3 className="text-base leading-5 font-extrabold text-text-primary sm:text-[19px] sm:leading-6">
                {f.title}
              </h3>
              <p className="text-sm leading-[1.5] font-medium text-text-secondary sm:text-[14.5px]">
                <Fit short={f.short} long={f.body} />
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Band>
  )
}

// ---------------------------------------------------------------------------
// Private by design
// ---------------------------------------------------------------------------

const TAKUSEN_HOLDS: { icon: LucideIcon; label: string }[] = [
  { icon: MailIcon, label: 'Your email address' },
  { icon: UserRoundIcon, label: 'Display name and avatar' },
  { icon: LockKeyholeIcon, label: 'Your password, hashed' },
  { icon: MonitorSmartphoneIcon, label: "Where you're signed in" },
]

const DEVICES_HOLD: { icon: LucideIcon; label: string }[] = [
  { icon: KeyRoundIcon, label: 'Message and call keys' },
  { icon: LifeBuoyIcon, label: 'Your recovery key' },
  { icon: MessagesSquareIcon, label: 'Messages and voice' },
  { icon: FileTextIcon, label: 'Files and pages' },
]

function HoldsColumn({
  head,
  title,
  tone,
  items,
}: {
  head: ReactNode
  title: string
  tone: 'gold' | 'voice'
  items: { icon: LucideIcon; label: string }[]
}): React.JSX.Element {
  const text = tone === 'gold' ? 'text-gold-text' : 'text-feature-voice-text'
  return (
    <div className="flex flex-1 flex-col gap-2.5 border border-line-hairline bg-surface-panel p-4 sm:gap-[18px] sm:border-0 sm:bg-transparent sm:p-7 sm:not-first:border-l">
      <h3 className="flex items-center gap-2.5">
        <span className="max-sm:hidden">{head}</span>
        <span
          className={cn(
            'text-[11.5px] leading-4 font-extrabold tracking-[1px] uppercase sm:text-[12.5px]',
            text,
          )}
        >
          {title}
        </span>
      </h3>
      <ul className="flex flex-col gap-2.5 sm:gap-[18px]">
        {items.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-2.5 border-line-hairline sm:gap-3 sm:border-t sm:py-2.5"
          >
            <item.icon aria-hidden className={cn('size-4 sm:size-[18px]', text)} />
            <span className="text-sm leading-5 font-semibold text-text-primary sm:text-[15px]">
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Security(): React.JSX.Element {
  return (
    <Band id="security" labelledBy="security-title" className="lg:flex-row lg:items-center lg:gap-16">
      <span id="privacy" className="sr-only" />
      <div className="flex flex-col gap-5 sm:gap-[18px] lg:w-[580px] lg:shrink-0">
        <Kicker tone="voice">Private by design</Kicker>
        <BandTitle id="security-title" className="sm:text-[44px]">
          Takusen knows who you are. <br className="max-sm:hidden" />
          Not what you say.
        </BandTitle>
        <p className="text-[15px] leading-[1.5] font-medium text-text-secondary sm:text-[16.5px]">
          <Fit
            short="Hachiman encrypts messages and calls on your devices. Takusen only holds what it needs to sign you in."
            long="Hachiman encrypts messages and calls on your devices before they leave. Takusen only holds what it needs to sign you in, so even the people who run it can't read your guilds."
          />
        </p>
      </div>
      <div className="flex flex-col gap-5 sm:flex-row sm:gap-0 sm:border sm:border-line-hairline sm:bg-surface-panel lg:flex-1">
        <HoldsColumn head={<TakusenMark size={24} />} title="Takusen holds" tone="gold" items={TAKUSEN_HOLDS} />
        <HoldsColumn
          head={
            <span className="flex size-6 items-center justify-center bg-feature-voice/15">
              <LockIcon className="size-[13px] text-feature-voice-text" />
            </span>
          }
          title="Only your devices hold"
          tone="voice"
          items={DEVICES_HOLD}
        />
      </div>
    </Band>
  )
}

// ---------------------------------------------------------------------------
// Regions (live status)
// ---------------------------------------------------------------------------

function RegionCell({ region }: { region: RegionStatus }): React.JSX.Element {
  const live = region.nodes.active
  return (
    <li className="flex flex-col gap-1 border-r border-b border-line-hairline p-3.5 sm:min-h-[196px] sm:gap-2.5 sm:p-7">
      <span className="font-mono text-[11.5px] leading-4 font-medium text-text-tertiary sm:text-[12.5px]">
        {region.code}
      </span>
      <span className="text-[15px] leading-5 font-extrabold text-text-primary sm:text-[21px] sm:leading-[26px]">
        {region.displayName}
      </span>
      <span className="flex items-end gap-2 sm:mt-auto">
        <span
          className={cn(
            'text-xl leading-6 font-extrabold sm:text-[30px] sm:leading-9 sm:tracking-[-0.6px]',
            live > 0 ? 'text-feature-voice-text' : 'text-text-disabled',
          )}
        >
          {live > 0 ? 'Online' : 'Offline'}
        </span>
        <span className="pb-0.5 text-[13px] leading-4 font-medium text-text-tertiary max-sm:hidden sm:pb-1.5">
          {live > 0 ? plural(live, 'voice node') : 'no voice nodes'}
        </span>
      </span>
    </li>
  )
}

export function Regions({ regions }: { regions: RegionStatus[] | null }): React.JSX.Element {
  return (
    <Band id="regions" labelledBy="regions-title">
      <div className="flex flex-col gap-5 sm:gap-3.5">
        <Kicker>Regions</Kicker>
        <BandTitle id="regions-title">Voice that stays close.</BandTitle>
      </div>
      <div id="status" className="scroll-mt-4">
        {regions === null ? (
          <p className="border border-line-hairline bg-surface-panel p-7 text-[15px] font-medium text-text-secondary">
            Region status is unavailable right now.
          </p>
        ) : regions.length === 0 ? (
          <p className="border border-line-hairline bg-surface-panel p-7 text-[15px] font-medium text-text-secondary">
            This deployment has no voice regions yet.
          </p>
        ) : (
          <ul className="grid grid-cols-2 border-t border-l border-line-hairline lg:grid-cols-4">
            {regions.map((r) => (
              <RegionCell key={r.code} region={r} />
            ))}
          </ul>
        )}
      </div>
    </Band>
  )
}

// ---------------------------------------------------------------------------
// Bring your guild
// ---------------------------------------------------------------------------

/** The two desktop builds (contract §4 Desktop updates): Takusen redirects to the newest zip. */
function DownloadButton({ download }: { download: HachimanLinks['download'] }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="xl" className="max-sm:h-11 sm:h-[50px] sm:px-[22px] sm:text-[15.5px]">
          <DownloadIcon aria-hidden />
          Download Hachiman
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {/* Plain links: the routes answer with a redirect to the zip, not with a page. */}
        <DropdownMenuItem asChild>
          <a href={download.macos}>macOS</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={download.windows}>Windows</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BringYourGuild({
  signedIn,
  download,
}: {
  signedIn: boolean
  download: HachimanLinks['download']
}): React.JSX.Element {
  return (
    <section id="download" aria-labelledby="cta-title" className="scroll-mt-4">
      <Container className="pt-2 pb-9 sm:pt-0 sm:pb-24">
        <div className="relative isolate flex flex-col gap-3.5 overflow-hidden border border-gold-line bg-[linear-gradient(180deg,var(--wash)_0%,var(--surface-window)_60%)] p-[22px] sm:p-14 lg:flex-row lg:items-center lg:gap-10">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-[300px] left-[700px] -z-10 h-[700px] w-[900px] rounded-full bg-[radial-gradient(closest-side,var(--glow),var(--glow-0))] max-lg:hidden"
          />
          <div className="flex flex-1 flex-col gap-3.5 sm:gap-3">
            <h2
              id="cta-title"
              className="text-[28px] leading-[1.15] font-extrabold tracking-[-0.6px] text-text-primary sm:text-[46px] sm:tracking-[-1.2px]"
            >
              Bring your guild.
            </h2>
            <p className="max-w-[640px] text-[15px] leading-[1.5] font-medium text-text-secondary sm:text-[17px]">
              <Fit
                short="Create a Takusen account, then open Hachiman."
                long="Create a Takusen account, then open Hachiman. Your guild is one invite away."
              />
            </p>
          </div>
          <div className="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:gap-3">
            <Button asChild size="xl" className="sm:h-[50px] sm:px-[22px] sm:text-[15.5px]">
              <Link href={signedIn ? '/dashboard' : '/signup'}>
                <ArrowRightIcon aria-hidden />
                {signedIn ? 'Open dashboard' : 'Create an account'}
              </Link>
            </Button>
            <DownloadButton download={download} />
          </div>
        </div>
      </Container>
    </section>
  )
}
