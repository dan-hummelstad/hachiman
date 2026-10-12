import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Lock, QrCode, RefreshCw, Smartphone, Smile, Timer } from 'lucide-react'
import { LINK_SESSION_TTL_MS, type CryptoEvents, type LinkStart } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import {
  formatCountdown,
  secondsLeft,
  useDeviceNoun,
  useStepLayout
} from '@/components/security/onboarding-steps'
import { CopyableCode, QrCodeView } from '@/components/security/qr-view'
import { SasEmojiRow } from '@/components/security/sas-emoji'
import { OptionCard, StepFrame } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { cn } from '@/lib/utils'
import { clearLinkState, useCryptoStore } from '@/stores/cryptoStore'
import { Callout } from '@/components/ui/callout'

type LinkMode = 'qr' | 'sas'

/** The new device's side of one link (§12.5): the session, its state and the actions. */
interface NewDeviceLink {
  mode: LinkMode | null
  session: LinkStart | null
  /** When the open session started (ms): the code's countdown runs from it. */
  startedAt: number | null
  sas: CryptoEvents['linkSas'] | null
  done: CryptoEvents['linkDone'] | null
  busy: boolean
  error: string | null
  start: (mode: LinkMode) => Promise<void>
  cancel: () => Promise<void>
  /** Stops the open session, then starts a new one ("Compare emoji instead", "New code"). */
  restart: (mode: LinkMode) => Promise<void>
  /** Forget the keys of this device and sign out. */
  startOver: () => void
}

/**
 * One link of this device to another (§12.5). The other device sends the keys; when they arrive,
 * the Worker reports the status 'ready'. A session that is open when the component unmounts, or
 * that comes back after a cancel or an unmount, is stopped, so the server keeps at most one
 * pending device. `autoStart` starts a session at mount, once: the ref survives StrictMode's second
 * effect run.
 */
function useNewDeviceLink({ autoStart }: { autoStart?: LinkMode } = {}): NewDeviceLink {
  const platform = usePlatform()
  const [mode, setMode] = useState<LinkMode | null>(null)
  const [session, setSession] = useState<LinkStart | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const { run, busy, error, clearError } = useAction()
  const sas = useCryptoStore((s) =>
    session && s.linkSas?.sessionId === session.sessionId ? s.linkSas : null
  )
  const done = useCryptoStore((s) =>
    session && s.linkDone?.sessionId === session.sessionId ? s.linkDone : null
  )

  // The open session, for the unmount. `generation` moves on each start and cancel, so a start
  // that resolves after a newer start or a cancel stops its own session.
  const open = useRef<string | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    open.current = session && !done ? session.sessionId : null
  }, [session, done])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const id = open.current
      if (id) stopSession(id)
    }
  }, [])
  useEffect(() => {
    if (!done) return
    platform.haptic(done.ok ? 'success' : 'warning')
    if (done.ok) void cryptoService.refreshStatus().catch(() => undefined)
  }, [done, platform])

  const start = useCallback(
    async (m: LinkMode): Promise<void> => {
      clearLinkState()
      clearError()
      setMode(m)
      const g = ++generation.current
      const r = await run('start the link', () =>
        friendly(cryptoService.client().linkAsNewDevice(m))
      )
      if (!r.ok) return
      if (g !== generation.current || !mounted.current) {
        stopSession(r.value.sessionId)
        return
      }
      setSession(r.value)
      setStartedAt(Date.now())
    },
    [run, clearError]
  )
  // Stops the open session. A start that is still on its way stops its own session.
  const stop = async (): Promise<void> => {
    generation.current++
    const id = session?.sessionId
    setSession(null)
    setStartedAt(null)
    clearLinkState()
    clearError()
    if (id && !done)
      await cryptoService
        .client()
        .linkCancel(id)
        .catch(() => undefined)
  }

  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStarted.current) return
    autoStarted.current = true
    void start(autoStart)
  }, [autoStart, start])

  return {
    mode,
    session,
    startedAt,
    sas,
    done,
    busy,
    error,
    start,
    cancel: async () => {
      setMode(null)
      await stop()
    },
    restart: async (m) => {
      // The new mode shows its start while the old session stops.
      setMode(m)
      await stop()
      await start(m)
    },
    startOver: () => void run('start over', () => cryptoService.signOutDevice())
  }
}

function stopSession(sessionId: string): void {
  void cryptoService
    .client()
    .linkCancel(sessionId)
    .catch(() => undefined)
}

/**
 * New device side of device linking (§12.5). The device shows a QR code (QR mode) or waits for
 * the other device and then shows the 7 emoji (SAS mode). The other device sends the keys; when
 * they arrive, the Worker reports the status 'ready' and the onboarding closes. Each state
 * renders a whole dialog step (header, body, footer). In the 'screen' layout (the mobile set-up
 * gate) it is M17: the QR code shows at once.
 */
export function LinkAsNewDevice({
  title = 'Link this device',
  onBack
}: {
  title?: string
  onBack: () => void
}): React.JSX.Element {
  return useStepLayout() === 'screen' ? (
    <LinkScreen title={title} onBack={onBack} />
  ) : (
    <LinkDialog title={title} onBack={onBack} />
  )
}

function LinkDialog({ title, onBack }: { title: string; onBack: () => void }): React.JSX.Element {
  const { mode, session, sas, done, busy, error, start, cancel, startOver } = useNewDeviceLink()

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
            <Button variant="quiet" disabled={busy} onClick={onBack}>
              Back
            </Button>
            <Button
              variant="quiet"
              className="sm:mr-auto"
              disabled={busy}
              title="Forget the keys of this device and sign out. Sign in again to start over."
              onClick={startOver}
            >
              Start over
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
          this one. You need it near you. If the link does not start, select <b>Start over</b>, then
          sign in again.
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
          <Callout tone="caution">
            This code is a secret for this link only. Show it only to your own device. It stops
            working after 10 minutes.
          </Callout>
        </>
      ) : sas ? (
        <>
          <p>
            Make sure that your other device shows the same emoji in the same order. Then confirm on
            the other device.
          </p>
          <SasEmojiRow emoji={sas.emoji} />
          <Callout tone="caution">
            If the emoji are different, select <b>They do not match</b> on the other device.
          </Callout>
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

/**
 * M17: the QR code at once (the session starts at mount), with its countdown, two steps and the
 * waiting line. "Compare emoji instead" stops the QR session and starts an emoji one. Back stops
 * the session.
 */
function LinkScreen({ title, onBack }: { title: string; onBack: () => void }): React.JSX.Element {
  const link = useNewDeviceLink({ autoStart: 'qr' })
  const { mode, session, startedAt, sas, done, busy, error } = link
  const noun = useDeviceNoun()
  // Back unmounts the screen, and the unmount stops the session. Each state has the same title:
  // the focus key moves the focus to it when the state changes (the tapped button goes away).
  const focusKey = done ? `done:${done.ok}` : `${mode ?? 'qr'}:${session ? 'open' : 'starting'}`
  const frame = { icon: <Smartphone />, title, onBack, focusKey }

  if (done) {
    return done.ok ? (
      <StepFrame {...frame} subtitle="Linked" onBack={undefined}>
        <p role="status" className="text-feature-voice-text flex items-center gap-2 font-semibold">
          <Check aria-hidden className="size-[18px]" />
          This {noun} is linked. Hachiman loads your guilds and messages now.
        </p>
      </StepFrame>
    ) : (
      <StepFrame
        {...frame}
        footer={
          <Button size="mobile" onClick={() => void link.restart('qr')}>
            <RefreshCw /> Try again
          </Button>
        }
      >
        <ErrorText>{`The link did not finish: ${cryptoErrorText({ code: done.error })}`}</ErrorText>
      </StepFrame>
    )
  }

  if (!session) {
    return (
      <StepFrame
        {...frame}
        subtitle="To a device where you use Hachiman"
        footer={
          error &&
          !busy && (
            <>
              <Button size="mobile" variant="quiet" onClick={link.startOver}>
                Start over
              </Button>
              <Button size="mobile" onClick={() => void link.start(mode ?? 'qr')}>
                <RefreshCw /> Try again
              </Button>
            </>
          )
        }
      >
        {busy || !error ? (
          <>
            {mode !== 'sas' && <div aria-hidden className={cn(QR_TILE, 'bg-surface-sunken')} />}
            <p role="status" className="text-text-secondary flex items-center gap-2">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              {mode === 'sas' ? 'Starting the emoji check…' : 'Making a link code…'}
            </p>
          </>
        ) : (
          <>
            <ErrorText>{error}</ErrorText>
            <p className="text-text-secondary">
              If the link does not start, select <b>Start over</b>. Hachiman forgets the keys of
              this {noun} and signs you out. Then sign in again.
            </p>
          </>
        )}
      </StepFrame>
    )
  }

  if (session.qrPayload && startedAt !== null) {
    return (
      <StepFrame
        {...frame}
        subtitle="To a device where you use Hachiman"
        footer={
          <>
            <p className="text-text-tertiary text-center text-[13.5px] font-semibold">
              No camera on the other device?
            </p>
            <Button
              size="mobile"
              variant="secondary"
              disabled={busy}
              onClick={() => void link.restart('sas')}
            >
              <Smile /> Compare emoji instead
            </Button>
            <p className="text-text-tertiary flex items-center justify-center gap-1.5 pt-1.5 text-[12.5px] font-semibold">
              <Lock aria-hidden className="text-feature-voice-text size-[13px]" />
              Keys travel end-to-end encrypted
            </p>
          </>
        }
      >
        <p className="text-text-secondary font-medium">
          Show this code to a device where you already use Hachiman. That device sends the keys to
          this {noun}.
        </p>
        <LinkCode
          key={session.sessionId}
          payload={session.qrPayload}
          expiresAt={startedAt + LINK_SESSION_TTL_MS}
          busy={busy}
          onNewCode={() => void link.restart('qr')}
        />
        <ErrorText>{error}</ErrorText>
      </StepFrame>
    )
  }

  return (
    <StepFrame
      {...frame}
      subtitle={`This ${noun} waits for your other device`}
      footer={
        !sas && (
          <Button
            size="mobile"
            variant="secondary"
            disabled={busy}
            onClick={() => void link.restart('qr')}
          >
            <QrCode /> Show a QR code instead
          </Button>
        )
      }
    >
      {sas ? (
        <>
          <p className="text-text-secondary">
            Check that your other device shows the same emoji in the same order. Then confirm on the
            other device.
          </p>
          <SasEmojiRow emoji={sas.emoji} size="touch" />
          <Callout size="touch" tone="caution">
            If the emoji are different, select <b>They do not match</b> on the other device.
          </Callout>
        </>
      ) : (
        <>
          <ol className="grid gap-3.5">
            <LinkStep n={1} touch>
              On a device where you use Hachiman, open <b>User settings → Devices</b>.
            </LinkStep>
            <LinkStep n={2} touch>
              Select <b>Link a new device</b>, then <b>Compare emoji</b>, and select this {noun}.
            </LinkStep>
          </ol>
          <Waiting>Waiting for your other device…</Waiting>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </StepFrame>
  )
}

/** The 200 white tile of the QR code (the code's quiet zone is in the SVG). */
const QR_TILE = 'mx-auto size-[200px] shrink-0'

/**
 * The QR code of M17 with its countdown ("Code works for 9:48"), the two steps and the waiting
 * line. Only this part ticks each second. At zero the code dims and "New code" makes another.
 */
function LinkCode({
  payload,
  expiresAt,
  busy,
  onNewCode
}: {
  payload: string
  expiresAt: number
  busy: boolean
  onNewCode: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const left = secondsLeft(expiresAt, now)
  const expired = left === 0
  useEffect(() => {
    if (expired) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expired])

  return (
    <>
      <div className="bg-surface-sunken border-line-hairline grid justify-items-center gap-3 border px-5 pt-5 pb-3.5">
        <QrCodeView
          value={payload}
          label="Link code for this device"
          className={cn(QR_TILE, 'max-w-none', expired && 'opacity-25')}
        />
        {expired ? (
          <div role="status" className="flex items-center gap-3">
            <span className="text-feature-danger-text text-[13.5px] font-semibold">
              The code expired.
            </span>
            <Button variant="secondary" className="h-9" disabled={busy} onClick={onNewCode}>
              <RefreshCw /> New code
            </Button>
          </div>
        ) : (
          <p className="text-text-tertiary flex items-center gap-1.5 text-[12.5px] leading-[18px] font-semibold tabular-nums">
            <Timer aria-hidden className="size-3.5" />
            Code works for {formatCountdown(left)}
          </p>
        )}
      </div>
      {!expired && (
        <>
          <ol className="grid gap-3.5">
            <LinkStep n={1} touch>
              On a device where you use Hachiman, open <b>User settings → Devices</b>.
            </LinkStep>
            <LinkStep n={2} touch>
              Select <b>Link a new device</b>, then scan this code.
            </LinkStep>
          </ol>
          <Waiting>Waiting for your other device…</Waiting>
        </>
      )}
      <p className="text-text-tertiary flex items-start gap-2 text-[13px] leading-[18px] font-medium">
        <Lock aria-hidden className="mt-px size-3.5 shrink-0" />
        This code is a secret for this link only. Show it only to your own device.
      </p>
    </>
  )
}

function LinkStep({
  n,
  touch,
  children
}: {
  n: number
  /** Phone size: a 26 number tile, text 15. */
  touch?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          'bg-accent-tint text-accent-text flex size-6 shrink-0 items-center justify-center text-[12px] font-bold',
          touch && 'size-[26px] text-[13px] font-extrabold'
        )}
      >
        {n}
      </span>
      <span className={touch ? 'pt-px' : undefined}>{children}</span>
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
