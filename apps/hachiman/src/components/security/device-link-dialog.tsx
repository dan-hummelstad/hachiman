import { useEffect, useRef, useState } from 'react'
import { Check, QrCode, Smile, X } from 'lucide-react'
import { LINK_QR_PREFIX } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { SelectableRow } from '@/components/ui/selectable-row'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { LinkAsNewDevice } from '@/components/security/link-new-device'
import { ScanOrPaste } from '@/components/security/qr-view'
import { SasEmojiRow } from '@/components/security/sas-emoji'
import { Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { clearLinkState, useCryptoStore } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'

interface PendingSession {
  sessionId: string
  newDeviceName: string
  platform: 'electron' | 'browser'
  createdAt: string
}

/**
 * Dialog kind 'deviceLink' (§12.5). Existing device: scan or paste the QR code of the new device,
 * or accept its request and compare the 7 emoji. The keys go to the new device only after the
 * scan, or after the user confirms that the emoji match. New device: the same flow as onboarding.
 */
export function DeviceLinkDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('deviceLink')
  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={dialog.role === 'existing_device' ? 'Link a new device' : 'Link this device'}
      className="sm:max-w-[520px]"
    >
      <div className="max-h-[75vh] overflow-y-auto">
        {dialog.role === 'existing_device' ? (
          <LinkFromThisDevice initialSessionId={dialog.sessionId} onClose={close} />
        ) : (
          <LinkAsNewDevice onBack={close} />
        )}
      </div>
    </ModalWindow>
  )
}

function LinkFromThisDevice({
  initialSessionId,
  onClose
}: {
  initialSessionId: string | null
  onClose: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'qr' | 'sas'>(initialSessionId ? 'sas' : 'qr')
  const [active, setActive] = useState<{ sessionId: string; name: string } | null>(null)
  const { run, busy, error, clearError } = useAction()
  const sas = useCryptoStore((s) =>
    active && s.linkSas?.sessionId === active.sessionId ? s.linkSas : null
  )
  const done = useCryptoStore((s) =>
    active && s.linkDone?.sessionId === active.sessionId ? s.linkDone : null
  )

  // Stop an open session when the window closes before the end.
  const open = useRef<string | null>(null)
  useEffect(() => {
    open.current = active && !done ? active.sessionId : null
  }, [active, done])
  useEffect(() => {
    clearLinkState()
    return () => {
      const id = open.current
      if (id)
        void cryptoService
          .client()
          .linkCancel(id)
          .catch(() => undefined)
    }
  }, [])

  const scan = async (payload: string): Promise<void> => {
    clearLinkState()
    const r = await run('link the device', () => friendly(cryptoService.client().linkScan(payload)))
    if (r.ok) setActive({ sessionId: r.value.sessionId, name: r.value.newDeviceName })
  }
  const accept = async (s: PendingSession): Promise<void> => {
    clearLinkState()
    setActive({ sessionId: s.sessionId, name: s.newDeviceName })
    const r = await run('accept the request', () =>
      friendly(cryptoService.client().linkAccept(s.sessionId))
    )
    if (!r.ok) setActive(null)
  }
  const confirm = async (matches: boolean): Promise<void> => {
    if (!active) return
    await run(matches ? 'send the keys' : 'stop the link', () =>
      friendly(cryptoService.client().linkConfirmSas(active.sessionId, matches))
    )
  }
  const restart = (): void => {
    const id = active?.sessionId
    setActive(null)
    clearLinkState()
    clearError()
    if (id && !done)
      void cryptoService
        .client()
        .linkCancel(id)
        .catch(() => undefined)
  }

  if (done) {
    return (
      <div className="grid gap-3">
        {done.ok ? (
          <p className="text-sm" role="status">
            <b>{active?.name}</b> is linked. It gets your messages now.
          </p>
        ) : (
          <ErrorText>{`The link did not finish: ${cryptoErrorText({ code: done.error })}`}</ErrorText>
        )}
        <div className="flex justify-end gap-2">
          {!done.ok && (
            <Button variant="ghost" onClick={restart}>
              Try again
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    )
  }

  if (active) {
    return (
      <div className="grid gap-4">
        {sas ? (
          <>
            <p className="text-sm">
              Compare these emoji with the emoji on <b>{active.name}</b>. They must be the same, in
              the same order.
            </p>
            <SasEmojiRow emoji={sas.emoji} />
            <ErrorText>{error}</ErrorText>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void confirm(false)}>
                <X /> They do not match
              </Button>
              <Button disabled={busy} onClick={() => void confirm(true)}>
                <Check /> They match
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm" role="status">
              {mode === 'sas'
                ? `Waiting for ${active.name}…`
                : `Sending the keys to ${active.name}…`}
            </p>
            <ErrorText>{error}</ErrorText>
          </>
        )}
        <Button variant="ghost" onClick={restart}>
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <Warning>
        Link only a device that you have with you now. A linked device can read all of your
        messages.
      </Warning>
      <div role="tablist" className="grid grid-cols-2 border">
        <ModeTab selected={mode === 'qr'} onClick={() => setMode('qr')}>
          <QrCode /> Scan the code
        </ModeTab>
        <ModeTab selected={mode === 'sas'} onClick={() => setMode('sas')}>
          <Smile /> Compare emoji
        </ModeTab>
      </div>
      {mode === 'qr' ? (
        <>
          <p className="text-sm">
            On the new device, select <b>Link from another device</b> and then <b>Show a QR code</b>
            . Scan the code, or copy its text there and paste it here.
          </p>
          <ScanOrPaste prefix={LINK_QR_PREFIX} busy={busy} onCode={(c) => void scan(c)} />
        </>
      ) : (
        <SessionPicker
          initialSessionId={initialSessionId}
          busy={busy}
          onPick={(s) => void accept(s)}
        />
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function ModeTab({
  selected,
  onClick,
  children
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'flex h-9 items-center justify-center gap-2 text-sm [&_svg]:size-4',
        selected ? 'bg-accent font-semibold' : 'text-muted-foreground hover:bg-accent/60'
      )}
    >
      {children}
    </button>
  )
}

/** The open link requests of the account (SAS mode). */
function SessionPicker({
  initialSessionId,
  busy,
  onPick
}: {
  initialSessionId: string | null
  busy: boolean
  onPick: (s: PendingSession) => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<PendingSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(initialSessionId)

  // Bumped by "Look again".
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => cryptoService.client().listLinkSessions())
      .then(
        (list) => {
          if (!live) return
          setSessions(list)
          setError(null)
        },
        (e: unknown) => live && setError(cryptoErrorText(e))
      )
    return () => {
      live = false
    }
  }, [attempt])

  const pick = sessions?.find((s) => s.sessionId === selected) ?? null
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        On the new device, select <b>Link from another device</b> and then <b>Compare emoji</b>.
        Then select the device here.
      </p>
      <ErrorText>{error}</ErrorText>
      {sessions?.length === 0 && (
        <p className="text-muted-foreground text-sm">No device asks to link now.</p>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="grid border">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <SelectableRow
                selected={s.sessionId === selected}
                onClick={() => setSelected(s.sessionId)}
              >
                <span className="truncate">{s.newDeviceName}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {s.platform === 'electron' ? 'Desktop app' : 'Browser'} ·{' '}
                  {new Date(s.createdAt).toLocaleTimeString()}
                </span>
              </SelectableRow>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          Look again
        </Button>
        <Button disabled={busy || !pick} onClick={() => pick && onPick(pick)}>
          Continue
        </Button>
      </div>
    </div>
  )
}
