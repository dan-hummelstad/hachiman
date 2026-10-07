import { useState } from 'react'
import {
  BadgeCheck,
  Check,
  MonitorSmartphone,
  QrCode,
  ScanLine,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react'
import { VERIFY_QR_PREFIX, type TrustInfo } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { friendly } from '@/components/security/errors'
import { TrustChip } from '@/components/people/trust-chip'
import { useContactSecurity } from '@/components/people/use-contact-security'
import { invalidateTrust } from '@/components/people/use-contact-trust'
import { QrCodeView, ScanOrPaste } from '@/components/security/qr-view'
import { useUserName } from '@/components/security/use-user-name'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { dismissKeyChange } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'
import { Callout } from '@/components/ui/callout'

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
 * the device certificates, only for devices whose certificate chain the Worker checked (§12.4).
 */
export function VerificationDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('verification')
  const { userId } = dialog
  const name = useUserName(userId)
  const { trust, safety, devices, error: loadError } = useContactSecurity(userId)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<'match' | 'mismatch' | null>(null)
  const [showCode, setShowCode] = useState(false)
  const { run, busy, error } = useAction()

  const setVerified = async (verified: boolean): Promise<void> => {
    const r = await run(verified ? 'mark as verified' : 'remove the verification', () =>
      friendly(cryptoService.client().setVerified(userId, verified))
    )
    if (!r.ok) return
    if (verified) dismissKeyChange(userId)
    invalidateTrust()
  }
  const acknowledge = async (): Promise<void> => {
    const r = await run('accept the new key', () =>
      friendly(cryptoService.client().acknowledgeKeyChange(userId))
    )
    if (!r.ok) return
    dismissKeyChange(userId)
    invalidateTrust()
  }
  const onScan = async (payload: string): Promise<void> => {
    setScanning(false)
    const r = await run('check the code', () => friendly(cryptoService.client().verifyQr(payload)))
    if (!r.ok) return
    const match = r.value.match && r.value.userId === userId
    setScanResult(match ? 'match' : 'mismatch')
    if (match) {
      dismissKeyChange(userId)
      invalidateTrust()
    }
  }

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={`Verify ${name}`}
      description={`Safety number for you and ${name}`}
      icon={<ShieldCheck />}
      feature="voice"
      className="sm:max-w-[560px]"
      actions={
        <Button variant="secondary" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="-mx-[22px] grid max-h-[70vh] gap-4 overflow-y-auto px-[22px]">
        {loadError && <ErrorText>{loadError}</ErrorText>}
        {trust && trust.state !== 'tofu' && (
          <p className="flex items-start gap-2 text-sm">
            {trust.state === 'verified' ? (
              <BadgeCheck className="text-feature-voice-text mt-0.5 size-4 shrink-0" />
            ) : trust.state === 'changed' ? (
              <ShieldAlert className="text-feature-danger-text mt-0.5 size-4 shrink-0" />
            ) : null}
            {TRUST_TEXT[trust.state]}
          </p>
        )}
        {trust?.state === 'changed' && (
          <Callout tone="danger">
            A new key can mean that {name} set up their account again. It can also mean that someone
            tries to read your messages. Compare the safety number with {name} in person or on a
            call before you trust it.
          </Callout>
        )}

        {safety && (
          <section className="grid gap-3">
            <p className="text-text-secondary text-sm">
              You and {name} see the same 60 digits. Compare them in person or on a call. If they
              match, nobody is between you.
            </p>
            <div
              aria-label="Safety number"
              className="border-line-hairline bg-surface-sunken grid grid-cols-4 gap-x-6 gap-y-2 border px-5 py-4 font-mono text-[20px] leading-7 font-semibold tracking-[0.08em]"
            >
              {safety.groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
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
              <Callout tone="caution">
                Paste only a code that you took from their device yourself. A code that came through
                a message or an email proves nothing.
              </Callout>
              <Button variant="quiet" onClick={() => setScanning(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="lg"
                disabled={busy}
                onClick={() => {
                  setScanResult(null)
                  setScanning(true)
                }}
              >
                <ScanLine /> Scan their code
              </Button>
              {trust?.state === 'verified' ? (
                <Button
                  variant="quiet"
                  size="lg"
                  disabled={busy}
                  onClick={() => void setVerified(false)}
                >
                  Remove verification
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={busy || !safety}
                  onClick={() => void setVerified(true)}
                >
                  <Check /> The numbers match — mark as verified
                </Button>
              )}
              {trust?.state === 'changed' && (
                <Button variant="quiet" disabled={busy} onClick={() => void acknowledge()}>
                  Accept the new key without a check
                </Button>
              )}
            </div>
          )}
          {scanResult === 'match' && (
            <p className="text-feature-voice-text text-sm font-semibold" role="status">
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
          {safety?.qrPayload &&
            (showCode ? (
              <div className="grid justify-items-center gap-1 pt-1">
                <QrCodeView value={safety.qrPayload} label={`Safety number code for ${name}`} />
                <span className="text-meta text-text-tertiary">
                  {name} can scan this code on their device.
                </span>
              </div>
            ) : (
              <Button
                variant="quiet"
                size="sm"
                className="justify-self-start"
                onClick={() => setShowCode(true)}
              >
                <QrCode /> Show my code for {name} to scan
              </Button>
            ))}
        </section>

        <section className="grid gap-2">
          <SectionHeading className="mb-0">
            Their devices{devices && devices.length > 0 ? ` · ${devices.length}` : ''}
          </SectionHeading>
          {devices === null ? (
            <p className="text-text-tertiary text-sm">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="text-text-tertiary text-sm">No verified devices.</p>
          ) : (
            <ul className="border-line-hairline bg-surface-sunken grid border text-sm">
              {devices.map((d) => (
                <li
                  key={d.deviceId}
                  className="border-line-hairline flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0"
                >
                  <MonitorSmartphone className="text-text-secondary size-[18px] shrink-0" />
                  <span className="grid min-w-0 flex-1">
                    <span className="text-label truncate">{d.displayName}</span>
                    <span className="text-meta text-text-tertiary">
                      added {new Date(d.issuedAtMs).toLocaleDateString()}
                    </span>
                  </span>
                  {trust && <TrustChip state={trust.state} />}
                </li>
              ))}
            </ul>
          )}
          <p className="text-meta text-text-tertiary">
            Device names come from the device certificates. A device you don’t expect can mean a
            problem: ask {name}.
          </p>
        </section>
      </div>
    </ModalWindow>
  )
}
