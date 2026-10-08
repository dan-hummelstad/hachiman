'use client'

import { ArrowUpRightIcon, CheckIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useSearchParams } from 'next/navigation'

import { AuthCard, AuthFooterLink, AuthScreen } from '@/components/auth-frame'
import { HandoffRail } from '@/components/handoff-rail'
import { HachimanMark } from '@/components/takusen-logo'
import { Button } from '@/components/ui/button'

const DEEP_LINK_SCHEME = 'app.hachiman://oauth-callback'

function buildDeepLink(params: URLSearchParams): string {
  // Preserve every param Takusen handed us (code, state, iss, error,
  // error_description, …). The Electron main process forwards the raw URL
  // it gets from the OS protocol handler to the renderer, and
  // TakusenService.completeSignIn parses them there.
  const qs = new URLSearchParams()
  for (const [key, value] of params.entries()) {
    qs.set(key, value)
  }
  return `${DEEP_LINK_SCHEME}?${qs.toString()}`
}

const noChanges = (): (() => void) => () => undefined

export function BridgeHandoff({ webUrl }: { webUrl: string }): React.JSX.Element {
  const search = useSearchParams()
  const deepLink = useMemo(
    () => (search ? buildDeepLink(new URLSearchParams(search.toString())) : null),
    [search],
  )
  const error = search?.get('error')
  const errorDescription = search?.get('error_description')
  // The host the browser names in its open-app prompt.
  const host = useSyncExternalStore(noChanges, () => window.location.host, () => null)

  // Hand off to the app once. The retry link below is derived from the same
  // values, so there is no state to set here.
  useEffect(() => {
    if (!deepLink || error) return
    window.location.assign(deepLink)
  }, [deepLink, error])

  if (error) {
    return (
      <AuthScreen>
        <AuthCard
          title="Sign-in failed"
          media={
            <span
              aria-hidden
              className="flex size-11 items-center justify-center bg-feature-danger/15 text-feature-danger-text"
            >
              <TriangleAlertIcon className="size-5" />
            </span>
          }
          lead={
            <>
              Takusen returned{' '}
              <code className="bg-surface-raised px-1 py-0.5 font-mono text-[13px] text-text-primary">
                {error}
              </code>
              {errorDescription ? `: ${errorDescription}` : ''}. You can close this tab and try
              again from the desktop app.
            </>
          }
        />
      </AuthScreen>
    )
  }

  return (
    <AuthScreen
      rail={
        <HandoffRail
          steps={[
            { product: 'hachiman', label: 'Hachiman', state: 'done' },
            { product: 'takusen', label: 'Signed in', state: 'done' },
            { product: 'hachiman', label: 'Back to Hachiman', state: 'current' },
          ]}
        />
      }
    >
      <AuthCard
        title="You're signed in"
        lead="We've handed you back to the Hachiman desktop app. You can close this tab."
        media={
          <span className="relative block size-[66px]">
            <HachimanMark size={56} />
            <span
              aria-hidden
              className="absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full border-2 border-surface-content bg-feature-voice text-[#0e0f15]"
            >
              <CheckIcon className="size-[15px]" strokeWidth={3} />
            </span>
          </span>
        }
        footer={
          <AuthFooterLink prompt="App didn't open?" href={webUrl}>
            Use Hachiman in the browser
          </AuthFooterLink>
        }
      >
        <div className="flex flex-col gap-3 border border-line-hairline bg-surface-raised p-4">
          <h2 className="section-label">If your browser asks</h2>
          <div
            aria-hidden
            className="flex flex-col gap-2.5 border border-line-strong bg-surface-content px-3.5 py-3"
          >
            <p className="text-[13.5px] leading-4 font-extrabold text-text-primary">Open Hachiman?</p>
            <p className="text-xs leading-4 font-medium text-text-tertiary">
              {host ?? 'This site'} wants to open this application.
            </p>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-[7px] text-xs font-semibold text-text-secondary">
                <span className="flex size-[15px] items-center justify-center rounded-[5px] bg-gold text-on-gold">
                  <CheckIcon className="size-[13px]" strokeWidth={3} />
                </span>
                Always allow
              </span>
              <span className="flex-1" />
              <span className="flex h-[26px] items-center rounded-[6px] border border-line-strong px-2.5 text-xs font-bold text-text-secondary">
                Cancel
              </span>
              <span className="flex h-[26px] items-center rounded-[6px] bg-accent-primary px-2.5 text-xs font-extrabold text-white outline-2 outline-gold">
                Open Hachiman
              </span>
            </div>
          </div>
          <p className="text-[13px] leading-[1.5] font-medium text-text-secondary">
            Press Open Hachiman. Tick Always allow and you won&apos;t see this again.
          </p>
        </div>
        {deepLink && (
          <Button asChild variant="secondary" size="lg" className="w-full">
            <a href={deepLink}>
              <ArrowUpRightIcon aria-hidden />
              Open Hachiman again
            </a>
          </Button>
        )}
      </AuthCard>
    </AuthScreen>
  )
}
