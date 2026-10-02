import { Globe, ShieldCheck } from 'lucide-react'
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
  if (hostTrust === null) return null
  if (hostTrust === 'server_code') return <HostTrustNote />
  return (
    <p className="text-muted-foreground flex items-start gap-2 text-xs leading-4">
      <ShieldCheck className="mt-px size-3.5 shrink-0" />
      <span>The desktop app runs its own code. The server cannot change it.</span>
    </p>
  )
}
