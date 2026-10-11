import { useCallback, useEffect, useRef, useState } from 'react'
import type { CryptoEvents, DevicePlatform } from '@hachiman/crypto'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { contactDevicePlatform } from '@/components/security/verification-model'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { clearLinkState, useCryptoStore } from '@/stores/cryptoStore'

/** An open link request of the account: a new device that asks to link. */
export interface PendingSession {
  sessionId: string
  newDeviceName: string
  platform: DevicePlatform
  createdAt: string
}

export type LinkMode = 'qr' | 'sas'

/** The new device of the open link: its session, its name and its platform, when known. */
export interface ActiveLink {
  sessionId: string
  name: string
  platform: DevicePlatform | null
}

/** The existing device's side of one link (§12.5): the state and the actions. */
export interface ExistingDeviceLink {
  mode: LinkMode
  setMode: (mode: LinkMode) => void
  active: ActiveLink | null
  sas: CryptoEvents['linkSas'] | null
  done: CryptoEvents['linkDone'] | null
  busy: boolean
  error: string | null
  /** The scanned or pasted QR code of the new device. */
  scan: (payload: string) => Promise<void>
  /** Accept a request (SAS mode): the emoji come next. */
  accept: (s: PendingSession) => Promise<void>
  /** The emoji match or not. True when the answer went out. */
  confirm: (matches: boolean) => Promise<boolean>
  /** Stop the open session and go back to the start. */
  restart: () => void
}

/**
 * One link from this device to a new one. A session that is open when the component unmounts is
 * stopped. A haptic tap marks the end on iOS: success when the device is linked, a warning when
 * the link failed.
 */
export function useExistingDeviceLink(initialSessionId: string | null): ExistingDeviceLink {
  const platform = usePlatform()
  const [mode, setMode] = useState<LinkMode>(initialSessionId ? 'sas' : 'qr')
  const [active, setActive] = useState<ActiveLink | null>(null)
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
  useEffect(() => {
    if (done) platform.haptic(done.ok ? 'success' : 'warning')
  }, [done, platform])

  const scan = async (payload: string): Promise<void> => {
    clearLinkState()
    const r = await run('link the device', () => friendly(cryptoService.client().linkScan(payload)))
    if (r.ok) {
      // A new device carries the name that this app gives its platform until the link ends.
      const name = r.value.newDeviceName
      setActive({ sessionId: r.value.sessionId, name, platform: contactDevicePlatform(name) })
    }
  }
  const accept = async (s: PendingSession): Promise<void> => {
    clearLinkState()
    setActive({ sessionId: s.sessionId, name: s.newDeviceName, platform: s.platform })
    const r = await run('accept the request', () =>
      friendly(cryptoService.client().linkAccept(s.sessionId))
    )
    if (!r.ok) setActive(null)
  }
  const confirm = async (matches: boolean): Promise<boolean> => {
    if (!active) return false
    const r = await run(matches ? 'send the keys' : 'stop the link', () =>
      friendly(cryptoService.client().linkConfirmSas(active.sessionId, matches))
    )
    return r.ok
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

  return { mode, setMode, active, sas, done, busy, error, scan, accept, confirm, restart }
}

/** The open link requests of the account, and a way to look again. */
export function useLinkSessions(): {
  sessions: PendingSession[] | null
  error: string | null
  reload: () => void
} {
  const [sessions, setSessions] = useState<PendingSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { sessions, error, reload }
}
