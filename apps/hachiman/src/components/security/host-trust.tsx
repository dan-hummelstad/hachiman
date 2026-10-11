import { Globe, ShieldCheck } from 'lucide-react'
import type { CryptoStatus, DeviceSummary } from '@hachiman/crypto'
import { Callout } from '@/components/ui/callout'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'

/**
 * The browser host label (§12.17): a hostile server can send hostile JavaScript to a browser, so
 * the web app trusts the server's code. The desktop app does not.
 */
export function HostTrustNote(): React.JSX.Element {
  return (
    <p className="text-muted-foreground flex items-start gap-2 text-xs leading-4">
      <Globe className="mt-px size-3.5 shrink-0" />
      <span>
        <b className="text-foreground">This browser trusts the server&apos;s code.</b> The server
        sends the web app each time you open it. A server that someone took over could send a
        changed app that reads your messages. Use the desktop app for the best protection.
      </span>
    </p>
  )
}

/** One line for settings: which kind of host this is. */
export function HostTrustLine(): React.JSX.Element | null {
  const hostTrust = useCryptoStore((s) => s.status?.hostTrust ?? null)
  const ios = usePlatform().platform === 'ios'
  if (hostTrust === null) return null
  if (hostTrust === 'server_code') return <HostTrustNote />
  return (
    <p className="text-muted-foreground mobile:text-[13px] mobile:leading-[1.45] flex items-start gap-2 text-xs leading-4">
      <ShieldCheck className="mobile:size-4 mt-px size-3.5 shrink-0" />
      <span>
        {ios ? 'The iPhone app' : 'The desktop app'} runs its own code. The server cannot change it.
      </span>
    </p>
  )
}

/**
 * The title of the web-trust callout of the mobile devices screen (M25), or null for none: this
 * browser, or the other browser devices of the account that are not signed out. Each one runs the
 * code that the server sends (§12.17). On the desktop only this host counts (spec §6.1, item 7).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function webTrustTitle(
  hostTrust: CryptoStatus['hostTrust'] | null,
  devices: readonly Pick<DeviceSummary, 'platform' | 'status' | 'current'>[] | null
): string | null {
  if (hostTrust === 'server_code') return 'This browser trusts the server’s code'
  const web = (devices ?? []).filter(
    (d) => !d.current && d.platform === 'browser' && d.status !== 'revoked'
  ).length
  if (web === 0) return null
  return web === 1
    ? 'Your web session trusts the server’s code'
    : 'Your web sessions trust the server’s code'
}

/**
 * The web-trust warning of the mobile devices screen (M25): a gold callout while this host or
 * another device of the account is a browser, with "Get the desktop app"; else the quiet line of
 * this host.
 */
export function WebTrustCallout({
  devices,
  desktopAppUrl
}: {
  devices: readonly DeviceSummary[] | null
  desktopAppUrl: string
}): React.JSX.Element | null {
  const hostTrust = useCryptoStore((s) => s.status?.hostTrust ?? null)
  const title = webTrustTitle(hostTrust, devices)
  if (title === null) return <HostTrustLine />
  return (
    <Callout
      tone="caution"
      size="touch"
      icon={<Globe />}
      title={title}
      action={{ label: 'Get the desktop app', href: desktopAppUrl }}
    >
      The server sends the web app each time it opens. A server that someone took over could send a
      changed app that reads your messages.
    </Callout>
  )
}
