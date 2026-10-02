import { useState } from 'react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import type { KtSelfCheckResult } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { friendly } from '@/components/security/errors'
import { Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { dismissKtAlerts, useCryptoStore } from '@/stores/cryptoStore'

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
  bad_proof: 'The server could not prove that a key is in the key log.'
}

/**
 * User settings → Security log (§12.14): the key transparency self-check and its alerts. The
 * Worker checks the log every 24 hours and on each key change of this account.
 */
export function SecurityLog(): React.JSX.Element {
  const alerts = useCryptoStore((s) => s.ktAlerts)
  const [result, setResult] = useState<KtSelfCheckResult | null>(null)
  const { run, busy, error } = useAction()

  const check = async (): Promise<void> => {
    const r = await run('check the key log', () => friendly(cryptoService.client().ktSelfCheck()))
    if (r.ok) setResult(r.value)
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm">
        The server keeps a public log of every security key and device of each account. Your devices
        check that each key change for your account came from one of your devices. If the server
        adds a device that you did not add, the check finds it.
      </p>

      {alerts.length > 0 && (
        <section className="grid gap-2">
          <SectionHeading>Alerts</SectionHeading>
          {alerts.map((a, i) => (
            <Warning key={i} tone="danger">
              <b>{ALERT_TEXT[a.kind] ?? a.kind}</b>
              {a.detail && <span className="text-muted-foreground block">{a.detail}</span>}
            </Warning>
          ))}
          <p className="text-muted-foreground text-xs leading-4">
            Look at your device list. Remove each device that you do not know, then make a new
            recovery key.
          </p>
          <div>
            <Button variant="ghost" size="sm" onClick={dismissKtAlerts}>
              Dismiss alerts
            </Button>
          </div>
        </section>
      )}

      <section className="grid gap-2">
        <SectionHeading>Check now</SectionHeading>
        <div>
          <Button variant="outline" disabled={busy} onClick={() => void check()}>
            {busy ? 'Checking…' : 'Check the key log'}
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
        {result &&
          (result.ok ? (
            <p className="flex items-center gap-2 text-sm" role="status">
              <ShieldCheck className="text-online size-4" />
              No problems. The log has {result.treeSize} entries.
            </p>
          ) : (
            <div className="grid gap-2" role="status">
              <p className="text-destructive flex items-center gap-2 text-sm font-semibold">
                <ShieldAlert className="size-4" />
                The log has changes that none of your devices made.
              </p>
              <ul className="grid gap-1 text-sm">
                {result.unknownEntries.map((e) => (
                  <li key={e.index} className="font-mono text-[13px]">
                    #{e.index} {ENTRY_TYPE[e.type] ?? `Type ${e.type}`}
                    {e.deviceId && ` · device ${e.deviceId}`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </section>
    </div>
  )
}
