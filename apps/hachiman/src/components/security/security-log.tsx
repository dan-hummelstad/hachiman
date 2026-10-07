import { useState } from 'react'
import { Globe, Monitor, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { KtSelfCheckResult } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { useOwnDevices } from '@/components/security/devices-panel'
import { friendly } from '@/components/security/errors'
import { Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { dismissKtAlerts, useCryptoStore } from '@/stores/cryptoStore'
import { useUserStore } from '@/stores/userStore'

const ENTRY_TYPE: Record<number, string> = {
  1: 'Security key',
  2: 'Device signing key',
  3: 'Device added',
  4: 'Device removed'
}

const ALERT_TEXT: Record<string, string> = {
  self_unknown_entry:
    'The key log has a key change for your account that none of your devices made.',
  split_view: 'The server showed two different versions of the key log.',
  bad_proof: 'The server could not prove that a key is in the key log.',
  kt_missing: 'The server sent a key that is not in the key log. The key was rejected.'
}

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * User settings → Security log (H4, §12.14): the key transparency self-check as one status card
 * with its button, the alerts, and the devices of this account as a timeline. The Worker checks
 * the log every 24 hours and on each key change of this account.
 */
export function SecurityLog(): React.JSX.Element {
  const alerts = useCryptoStore((s) => s.ktAlerts)
  const me = useUserStore((s) => s.me?.username)
  const { devices } = useOwnDevices()
  const [result, setResult] = useState<{ value: KtSelfCheckResult; at: Date } | null>(null)
  const { run, busy, error } = useAction()

  const check = async (): Promise<void> => {
    const r = await run('check the key log', () => friendly(cryptoService.client().ktSelfCheck()))
    if (r.ok) setResult({ value: r.value, at: new Date() })
  }

  const bad = alerts.length > 0 || result?.value.ok === false
  const timeline = [...(devices ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="grid gap-6">
      <div
        className={cn(
          'flex items-center gap-3 border px-4 py-3',
          bad
            ? 'border-feature-danger/50 bg-feature-danger/5'
            : 'bg-surface-panel border-line-hairline'
        )}
      >
        <span
          className={cn(
            'rounded-control flex size-9 shrink-0 items-center justify-center [&_svg]:size-5',
            bad
              ? 'bg-feature-danger/15 text-feature-danger-text'
              : result
                ? 'bg-feature-voice/15 text-feature-voice-text'
                : 'bg-surface-raised text-text-tertiary'
          )}
        >
          {bad ? <ShieldAlert /> : result ? <ShieldCheck /> : <ShieldQuestion />}
        </span>
        <div className="grid min-w-0 flex-1" role="status">
          <span className="text-label">
            {bad
              ? 'The log has changes that none of your devices made'
              : result
                ? 'All clear'
                : 'Not checked from this window yet'}
          </span>
          <span className="text-meta text-text-tertiary">
            {result
              ? `Last checked at ${TIME.format(result.at)} · the log has ${result.value.treeSize} entries`
              : 'Your devices also check it every 24 hours and on each key change.'}
          </span>
        </div>
        <Button variant="secondary" size="lg" disabled={busy} onClick={() => void check()}>
          <RefreshCw className={cn(busy && 'animate-spin')} />
          {busy ? 'Checking…' : 'Check the key log'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>

      {result && !result.value.ok && (
        <ul className="grid gap-1 text-sm">
          {result.value.unknownEntries.map((e) => (
            <li key={e.index} className="text-feature-danger-text font-mono text-[13px]">
              #{e.index} {ENTRY_TYPE[e.type] ?? `Type ${e.type}`}
              {e.deviceId && ` · device ${e.deviceId}`}
            </li>
          ))}
        </ul>
      )}

      {alerts.length > 0 && (
        <section className="grid gap-2">
          <SectionHeading className="mb-0">Alerts</SectionHeading>
          {alerts.map((a, i) => (
            <Warning key={i} tone="danger">
              <b>{ALERT_TEXT[a.kind] ?? a.kind}</b>
              {a.detail && <span className="text-text-tertiary block">{a.detail}</span>}
            </Warning>
          ))}
          <p className="text-meta text-text-tertiary">
            Look at your device list. Sign out each device that you do not know, then make a new
            recovery key.
          </p>
          <div>
            <Button variant="quiet" size="sm" onClick={dismissKtAlerts}>
              Dismiss alerts
            </Button>
          </div>
        </section>
      )}

      {timeline.length > 0 && (
        <section>
          <SectionHeading>Devices{me && ` · ${me}`}</SectionHeading>
          <ol className="grid">
            {timeline.map((d, i) => (
              <li key={d.id} className="relative flex gap-3 pb-4">
                {i < timeline.length - 1 && (
                  <span
                    aria-hidden
                    className="bg-line-strong absolute top-9 bottom-0 left-[17px] w-0.5"
                  />
                )}
                <span className="bg-surface-raised border-line-hairline text-text-secondary flex size-9 shrink-0 items-center justify-center rounded-full border [&_svg]:size-4">
                  {d.platform === 'electron' ? <Monitor aria-hidden /> : <Globe aria-hidden />}
                </span>
                <div className="grid min-w-0 flex-1 pt-1">
                  <span className="text-label">Added {d.current ? 'this device' : d.name}</span>
                  <span className="text-meta text-text-tertiary">
                    {d.status === 'revoked'
                      ? 'Signed out since'
                      : d.primary
                        ? 'Has your security key'
                        : d.platform === 'electron'
                          ? 'Desktop app'
                          : 'Browser'}
                  </span>
                </div>
                <span className="text-meta text-text-tertiary shrink-0 pt-1">
                  {DAY.format(new Date(d.createdAt))}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
