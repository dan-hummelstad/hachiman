import { useEffect, useRef, useState } from 'react'
import { QrCode, Smile } from 'lucide-react'
import type { LinkStart } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { CopyableCode, QrCodeView } from '@/components/security/qr-view'
import { SasEmojiRow } from '@/components/security/sas-emoji'
import { Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { clearLinkState, useCryptoStore } from '@/stores/cryptoStore'

/**
 * New device side of device linking (§12.5). The device shows a QR code (QR mode) or waits for
 * the other device and then shows the 7 emoji (SAS mode). The other device sends the keys; when
 * they arrive, the Worker reports the status 'ready' and the onboarding closes.
 */
export function LinkAsNewDevice({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'qr' | 'sas' | null>(null)
  const [session, setSession] = useState<LinkStart | null>(null)
  const { run, busy, error, clearError } = useAction()
  const sas = useCryptoStore((s) =>
    session && s.linkSas?.sessionId === session.sessionId ? s.linkSas : null
  )
  const done = useCryptoStore((s) =>
    session && s.linkDone?.sessionId === session.sessionId ? s.linkDone : null
  )

  // Leave an open session when the user goes away before it finished.
  const open = useRef<string | null>(null)
  useEffect(() => {
    open.current = session && !done ? session.sessionId : null
  }, [session, done])
  useEffect(
    () => () => {
      const id = open.current
      if (id)
        void cryptoService
          .client()
          .linkCancel(id)
          .catch(() => undefined)
    },
    []
  )
  useEffect(() => {
    if (done?.ok) void cryptoService.refreshStatus().catch(() => undefined)
  }, [done])

  const start = async (m: 'qr' | 'sas'): Promise<void> => {
    clearLinkState()
    clearError()
    setMode(m)
    const r = await run('start the link', () => friendly(cryptoService.client().linkAsNewDevice(m)))
    if (r.ok) setSession(r.value)
  }
  const cancel = async (): Promise<void> => {
    const id = session?.sessionId
    setSession(null)
    setMode(null)
    clearLinkState()
    if (id && !done)
      await cryptoService
        .client()
        .linkCancel(id)
        .catch(() => undefined)
  }

  if (done) {
    return done.ok ? (
      <p className="text-sm" role="status">
        This device is linked. Hachiman loads your guilds and messages now.
      </p>
    ) : (
      <div className="grid gap-3">
        <ErrorText>{`The link did not finish: ${cryptoErrorText({ code: done.error })}`}</ErrorText>
        <Button onClick={() => void cancel()}>Try again</Button>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="grid gap-3">
        <p className="text-sm">
          Link this device to a device where you already use Hachiman. That device sends the keys to
          this device. You need it near you.
        </p>
        <Button variant="outline" disabled={busy} onClick={() => void start('qr')}>
          <QrCode /> {busy && mode === 'qr' ? 'Starting…' : 'Show a QR code'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void start('sas')}>
          <Smile /> {busy && mode === 'sas' ? 'Starting…' : 'Compare emoji (no camera)'}
        </Button>
        <ErrorText>{error}</ErrorText>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      {session.qrPayload ? (
        <>
          <p className="text-sm">
            On your other device, open <b>User settings → Devices</b> and select{' '}
            <b>Link a new device</b>. Then scan this code, or copy the text and paste it there.
          </p>
          <QrCodeView
            value={session.qrPayload}
            label="Link code for this device"
            className="justify-self-center"
          />
          <CopyableCode value={session.qrPayload} label="Code text" />
          <Warning>
            This code is a secret for this link only. Show it only to your own device. It stops
            working after 10 minutes.
          </Warning>
        </>
      ) : sas ? (
        <>
          <p className="text-sm">
            Make sure that your other device shows the same emoji in the same order. Then confirm on
            the other device.
          </p>
          <SasEmojiRow emoji={sas.emoji} />
          <Warning>
            If the emoji are different, select <b>They do not match</b> on the other device.
          </Warning>
        </>
      ) : (
        <p className="text-sm" role="status">
          On your other device, open <b>User settings → Devices</b>, select <b>Link a new device</b>{' '}
          and then <b>Compare emoji</b>. Select this device in the list. The emoji show here when
          the other device accepts.
        </p>
      )}
      <Button variant="ghost" onClick={() => void cancel()}>
        Cancel
      </Button>
    </div>
  )
}
