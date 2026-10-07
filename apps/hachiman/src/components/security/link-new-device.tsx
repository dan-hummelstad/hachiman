import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Lock, QrCode, Smartphone, Smile } from 'lucide-react'
import type { LinkStart } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { CopyableCode, QrCodeView } from '@/components/security/qr-view'
import { SasEmojiRow } from '@/components/security/sas-emoji'
import { OptionCard, StepFrame, Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { clearLinkState, useCryptoStore } from '@/stores/cryptoStore'

/**
 * New device side of device linking (§12.5). The device shows a QR code (QR mode) or waits for
 * the other device and then shows the 7 emoji (SAS mode). The other device sends the keys; when
 * they arrive, the Worker reports the status 'ready' and the onboarding closes. Each state
 * renders a whole dialog step (header, body, footer).
 */
export function LinkAsNewDevice({
  title = 'Link this device',
  onBack
}: {
  title?: string
  onBack: () => void
}): React.JSX.Element {
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

  const frame = {
    icon: <Smartphone />,
    title,
    subtitle: session
      ? 'This device waits for your other one'
      : 'To a device where you use Hachiman'
  }

  if (done) {
    return done.ok ? (
      <StepFrame {...frame} icon={<Check />} feature="voice">
        <p role="status">This device is linked. Hachiman loads your guilds and messages now.</p>
      </StepFrame>
    ) : (
      <StepFrame
        {...frame}
        feature="danger"
        footer={<Button onClick={() => void cancel()}>Try again</Button>}
      >
        <ErrorText>{`The link did not finish: ${cryptoErrorText({ code: done.error })}`}</ErrorText>
      </StepFrame>
    )
  }

  if (!session) {
    return (
      <StepFrame
        {...frame}
        footer={
          <>
            <Button variant="quiet" className="sm:mr-auto" disabled={busy} onClick={onBack}>
              Back
            </Button>
            <span className="text-meta text-text-tertiary flex items-center gap-1.5">
              <Lock aria-hidden className="size-3.5" />
              Keys travel end-to-end encrypted
            </span>
          </>
        }
      >
        <p>
          Link this device to a device where you already use Hachiman. That device sends the keys to
          this one. You need it near you.
        </p>
        <OptionCard
          icon={busy && mode === 'qr' ? <Loader2 className="animate-spin" /> : <QrCode />}
          title="Show a QR code"
          hint="Scan it with the camera of your other device."
          emphasis
          disabled={busy}
          onClick={() => void start('qr')}
        />
        <OptionCard
          icon={busy && mode === 'sas' ? <Loader2 className="animate-spin" /> : <Smile />}
          feature="event"
          title="Compare emoji"
          hint="No camera? Check that both screens show the same emoji."
          disabled={busy}
          onClick={() => void start('sas')}
        />
        <ErrorText>{error}</ErrorText>
      </StepFrame>
    )
  }

  return (
    <StepFrame
      {...frame}
      footer={
        <Button variant="secondary" onClick={() => void cancel()}>
          Cancel
        </Button>
      }
    >
      {session.qrPayload ? (
        <>
          <div className="grid items-center gap-4 sm:grid-cols-[176px_1fr]">
            <QrCodeView
              value={session.qrPayload}
              label="Link code for this device"
              className="justify-self-center sm:max-w-[176px]"
            />
            <ol className="grid gap-3">
              <LinkStep n={1}>
                On a device where you use Hachiman, open <b>User settings → Devices</b>.
              </LinkStep>
              <LinkStep n={2}>
                Select <b>Link a new device</b>, then scan this code, or paste its text there.
              </LinkStep>
              <Waiting>Waiting for your other device…</Waiting>
            </ol>
          </div>
          <CopyableCode value={session.qrPayload} label="Code text" />
          <Warning>
            This code is a secret for this link only. Show it only to your own device. It stops
            working after 10 minutes.
          </Warning>
        </>
      ) : sas ? (
        <>
          <p>
            Make sure that your other device shows the same emoji in the same order. Then confirm on
            the other device.
          </p>
          <SasEmojiRow emoji={sas.emoji} />
          <Warning>
            If the emoji are different, select <b>They do not match</b> on the other device.
          </Warning>
        </>
      ) : (
        <>
          <p>
            On your other device, open <b>User settings → Devices</b>, select{' '}
            <b>Link a new device</b> and then <b>Compare emoji</b>. Select this device in the list.
            The emoji show here when the other device accepts.
          </p>
          <Waiting>Waiting for your other device…</Waiting>
        </>
      )}
    </StepFrame>
  )
}

function LinkStep({ n, children }: { n: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="bg-accent-tint text-accent-text flex size-6 shrink-0 items-center justify-center text-[12px] font-bold"
      >
        {n}
      </span>
      <span>{children}</span>
    </li>
  )
}

/** The gold waiting line with a spinner. */
export function Waiting({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p role="status" className="text-feature-event-text flex items-center gap-2 font-semibold">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {children}
    </p>
  )
}
