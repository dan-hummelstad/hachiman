import { LandingFooter } from '@/components/marketing/landing-footer'
import { LandingHero, type NavLink } from '@/components/marketing/landing-hero'
import {
  BringYourGuild,
  Features,
  HowItWorks,
  Regions,
  Security,
} from '@/components/marketing/landing-sections'
import { getOptionalUser } from '@/lib/auth-helpers'
import { hachimanLinks } from '@/lib/deployment'
import { listRegionStatus, type RegionStatus } from '@/lib/regions'

async function regionStatus(): Promise<RegionStatus[] | null> {
  try {
    return await listRegionStatus()
  } catch (err) {
    // The landing page must render without the database; the band says the status is unavailable.
    console.warn('[landing] region status', err)
    return null
  }
}

export default async function MarketingHomePage(): Promise<React.JSX.Element> {
  const [session, regions] = await Promise.all([getOptionalUser(), regionStatus()])
  const signedIn = session !== null
  const hachiman = hachimanLinks()
  const links: NavLink[] = [
    { label: 'Hachiman', href: hachiman.web },
    { label: 'How it works', href: '/#how-it-works' },
    { label: 'Security', href: '/#security' },
    { label: 'Regions', href: '/#regions' },
    { label: 'Status', href: '/#status' },
  ]

  return (
    <div className="flex min-h-dvh flex-col bg-surface-window text-text-primary">
      <main className="flex-1">
        <LandingHero links={links} signedIn={signedIn} />
        <HowItWorks />
        <Features />
        <Security />
        <Regions regions={regions} />
        <BringYourGuild signedIn={signedIn} download={hachiman.download} />
      </main>
      <LandingFooter hachimanUrl={hachiman.web} />
    </div>
  )
}
