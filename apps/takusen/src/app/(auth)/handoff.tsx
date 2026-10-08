import { HandoffRail, type HandoffStep } from '@/components/handoff-rail'

export type SearchParam = string | string[] | undefined

export function firstParam(value: SearchParam): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Only same-origin relative paths, so `next` cannot become an open redirect. */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return undefined
  return value
}

/** An OIDC interaction means an app (Hachiman) sent the visitor here and gets them back after. */
export function fromApp(next: string | undefined): boolean {
  return next?.startsWith('/oidc/interaction/') ?? false
}

/** Keeps the app handoff alive across the sign-in, sign-up and recovery pages. */
export function withNext(href: string, next: string | undefined): string {
  const safe = safeNext(next)
  return safe ? `${href}?next=${encodeURIComponent(safe)}` : href
}

/** The handoff rail for an SSO page, or nothing when no app sent the visitor. */
export function AppRail({ next, label }: { next: string | undefined; label: string }): React.JSX.Element | null {
  if (!fromApp(next)) return null
  const steps: HandoffStep[] = [
    { product: 'hachiman', label: 'Hachiman', state: 'done' },
    { product: 'takusen', label, state: 'current' },
    { product: 'hachiman', label: 'Back to Hachiman', state: 'next' },
  ]
  return <HandoffRail steps={steps} />
}
