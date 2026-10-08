import Link from 'next/link'

import { Container } from '@/components/marketing/band'
import type { NavLink } from '@/components/marketing/landing-hero'
import { ThemeSwitch } from '@/components/marketing/theme-switch'
import { Brand } from '@/components/takusen-logo'
import { cn } from '@/lib/utils'

function FooterColumn({
  title,
  links,
  className,
}: {
  title: string
  links: NavLink[]
  className?: string
}): React.JSX.Element {
  return (
    <nav aria-label={title} className={cn('flex flex-1 flex-col gap-2.5 sm:w-[180px] sm:flex-none sm:gap-3', className)}>
      <h2 className="text-[11.5px] leading-4 font-extrabold tracking-[1px] text-text-tertiary uppercase sm:text-xs">
        {title}
      </h2>
      {links.map((l) => (
        <Link
          key={l.label}
          href={l.href}
          className="w-fit text-sm leading-5 font-semibold text-text-secondary hover:text-text-primary sm:text-[14.5px]"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  )
}

export function LandingFooter({ hachimanUrl }: { hachimanUrl: string }): React.JSX.Element {
  return (
    <footer className="border-t border-line-hairline">
      <Container className="flex flex-col gap-[22px] pt-7 pb-8 sm:gap-10 sm:pt-12 sm:pb-10">
        <div className="flex flex-col gap-[22px] sm:flex-row sm:gap-12">
          <div className="flex flex-1 flex-col gap-3">
            <Link href="/" aria-label="Takusen home" className="w-fit rounded-control">
              <Brand />
            </Link>
            <p className="max-w-[340px] text-sm leading-[1.5] font-medium text-text-tertiary max-sm:hidden">
              The account behind Hachiman. Run by the people who run your Hachiman deployment.
            </p>
          </div>
          <div className="flex gap-5 sm:gap-12">
            <FooterColumn
              title="Product"
              links={[
                { label: 'Hachiman', href: hachimanUrl },
                { label: 'Download', href: '/#download' },
                { label: 'Status', href: '/#status' },
              ]}
            />
            <FooterColumn
              title="Account"
              links={[
                { label: 'Sign in', href: '/login' },
                { label: 'Create account', href: '/signup' },
                { label: 'Reset password', href: '/forgot-password' },
              ]}
            />
            <FooterColumn
              title="Legal"
              className="max-sm:hidden"
              links={[
                { label: 'Privacy', href: '/#privacy' },
                { label: 'Security model', href: '/#security' },
              ]}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 sm:border-t sm:border-line-hairline sm:pt-5">
          <p className="text-[12.5px] leading-4 font-medium text-text-tertiary sm:text-[13px]">
            © {new Date().getFullYear()} Takusen · 託宣
            <span className="sm:hidden">
              {' · '}
              <Link href="/#privacy" className="hover:text-text-primary">
                Privacy
              </Link>
            </span>
          </p>
          <div className="ml-auto max-sm:hidden">
            <ThemeSwitch />
          </div>
        </div>
      </Container>
    </footer>
  )
}
