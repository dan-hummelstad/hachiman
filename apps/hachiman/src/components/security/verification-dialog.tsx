import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, MonitorSmartphone, ScanLine, ShieldAlert } from 'lucide-react'
import { VERIFY_QR_PREFIX, type SafetyNumber, type TrustInfo } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { contactDevices, type ContactDevice } from '@/components/security/device-names'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { QrCodeView, ScanOrPaste } from '@/components/security/qr-view'
import { Warning } from '@/components/security/screen-window'
import { useUserName } from '@/components/security/use-user-name'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'
import { dismissKeyChange } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'

const TRUST_TEXT: Record<TrustInfo['state'], string> = {
  verified: 'You verified this person.',
  tofu: 'Not verified. Hachiman uses the security key that it saw first for this person.',
  changed: 'The security key of this person changed. Verify them again.',
  unknown: 'Hachiman has no security key for this person yet.'
}

/**
 * Dialog kind 'verification' (§12.5): the safety number of me and one contact, as 12 groups of 5
 * digits and as a QR code. Verify by a scan of their code, or by comparing the digits and then
 * "Mark as verified". Users verify accounts, not devices. The device list shows the names from
 * the device certificates.
 */
export function VerificationDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('verification')
  const { userId } = dialog
  const name = useUserName(userId)
  const [trust, setTrust] = useState<TrustInfo | null>(null)
  const [safety, setSafety] = useState<SafetyNumber | null>(null)
  const [devices, setDevices] = useState<ContactDevice[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<'match' | 'mismatch' | null>(null)
  const { run, busy, error } = useAction()

  const load = useCallback(() => {
    // client() throws when the Worker is not ready: inside the promise, so it is a load error.
    Promise.resolve()
      .then(() => {
        const client = cryptoService.client()
        return Promise.all([client.getTrust(userId), client.getSafetyNumber(userId)])
      })
      .then(
        ([t, s]) => {
          setTrust(t)
          setSafety(s)
        },
        (e: unknown) => setLoadError(cryptoErrorText(e))
      )
    hachiman.rest.getUserKeys(userId).then(
      (keys) => setDevices(contactDevices(keys)),
      () => setDevices([])
    )
  }, [userId])
  useEffect(load, [load])

  const setVerified = async (verified: boolean): Promise<void> => {
    const r = await run(verified ? 'mark as verified' : 'remove the verification', () =>
      friendly(cryptoService.client().setVerified(userId, verified))
    )
    if (!r.ok) return
    setTrust(r.value)
    if (verified) dismissKeyChange(userId)
  }
  const acknowledge = async (): Promise<void> => {
    const r = await run('accept the new key', () =>
      friendly(cryptoService.client().acknowledgeKeyChange(userId))
    )
    if (!r.ok) return
    setTrust(r.value)
    dismissKeyChange(userId)
    load()
  }
  const onScan = async (payload: string): Promise<void> => {
    setScanning(false)
    const r = await run('check the code', () => friendly(cryptoService.client().verifyQr(payload)))
    if (!r.ok) return
    const match = r.value.match && r.value.userId === userId
    setScanResult(match ? 'match' : 'mismatch')
    if (match) {
      dismissKeyChange(userId)
      load()
    }
  }

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={`Verify ${name}`}
      className="sm:max-w-[520px]"
      actions={
        <Button variant="ghost" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="grid max-h-[70vh] gap-4 overflow-y-auto">
        {loadError && <ErrorText>{loadError}</ErrorText>}
        {trust && (
          <p className="flex items-start gap-2 text-sm">
            {trust.state === 'verified' ? (
              <BadgeCheck className="text-online mt-0.5 size-4 shrink-0" />
            ) : trust.state === 'changed' ? (
              <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" />
            ) : null}
            {TRUST_TEXT[trust.state]}
          </p>
        )}
        {trust?.state === 'changed' && (
          <Warning tone="danger">
            A new key can mean that {name} set up their account again. It can also mean that someone
            tries to read your messages. Compare the safety number with {name} in person or on a
            call before you trust it.
          </Warning>
        )}

        {safety && (
          <section className="grid gap-3">
            <SectionHeading>Safety number</SectionHeading>
            <p className="text-muted-foreground text-xs leading-4">
              You and {name} see the same 60 digits. Compare them in person or on a call. If they
              are the same, nobody is between you.
            </p>
            <div
              aria-label="Safety number"
              className="bg-card grid grid-cols-4 gap-x-4 gap-y-1 border p-3 font-mono text-[15px] leading-6 tracking-wider"
            >
              {safety.groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
            {safety.qrPayload && (
              <div className="grid justify-items-center gap-1">
                <QrCodeView value={safety.qrPayload} label={`Safety number code for ${name}`} />
                <span className="text-muted-foreground text-xs">
                  {name} can scan this code on their device.
                </span>
              </div>
            )}
          </section>
        )}

        <section className="grid gap-2">
          {scanning ? (
            <>
              <ScanOrPaste
                prefix={VERIFY_QR_PREFIX}
                busy={busy}
                pasteLabel="Or paste the code text from their device"
                onCode={(c) => void onScan(c)}
              />
              <Warning>
                Paste only a code that you took from their device yourself. A code that came through
                a message or an email proves nothing.
              </Warning>
              <Button variant="ghost" onClick={() => setScanning(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setScanResult(null)
                  setScanning(true)
                }}
              >
                <ScanLine /> Scan their code
              </Button>
              {trust?.state === 'verified' ? (
                <Button variant="ghost" disabled={busy} onClick={() => void setVerified(false)}>
                  Remove verification
                </Button>
              ) : (
                <Button disabled={busy || !safety} onClick={() => void setVerified(true)}>
                  <BadgeCheck /> The numbers match: mark as verified
                </Button>
              )}
              {trust?.state === 'changed' && (
                <Button variant="ghost" disabled={busy} onClick={() => void acknowledge()}>
                  Accept the new key without a check
                </Button>
              )}
            </div>
          )}
          {scanResult === 'match' && (
            <p className="text-online text-sm font-semibold" role="status">
              The code matches. {name} is verified.
            </p>
          )}
          {scanResult === 'mismatch' && (
            <ErrorText>
              The code does not match. Do not mark {name} as verified. Ask them to show their code
              again.
            </ErrorText>
          )}
          <ErrorText>{error}</ErrorText>
        </section>

        <section className="grid gap-2">
          <SectionHeading>Their devices</SectionHeading>
          {devices === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active devices.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {devices.map((d) => (
                <li key={d.deviceId} className="flex items-center gap-2">
                  <MonitorSmartphone className="size-4 shrink-0" />
                  <span className="truncate">{d.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                    since {d.issuedAt.toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground text-xs leading-4">
            The names come from the device certificates. A device that you do not expect can mean a
            problem: ask {name}.
          </p>
        </section>
      </div>
    </ModalWindow>
  )
}
