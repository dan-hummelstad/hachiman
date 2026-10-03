/**
 * The awareness half of a DocProvider (contract §6 op 5, §12.20): y-protocols states as
 * doc_awareness envelopes, at most one per AWARENESS_MS, and again every HEARTBEAT_MS.
 * y-protocols drops a peer after 30 s. A frame from a new peer gets my state back, so a new viewer
 * sees everyone at once.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { DocPeer } from '@/stores/docsStore'
import type { DocProviderDeps } from './DocProvider'

export const AWARENESS_MS = 100
export const HEARTBEAT_MS = 15_000
const REMOTE = 'remote'

type AwarenessDeps = Pick<
  DocProviderDeps,
  'crypto' | 'sendAwareness' | 'deviceId' | 'me' | 'online' | 'setPresence'
>

export interface DocAwareness {
  readonly awareness: Awareness
  /** Sends my state (throttled). The provider calls it when the page is live. */
  announce(): void
  receive(d: { deviceId: string; envelope: string }): void
  /** Before doc.destroy, which destroys the awareness and so sends the null state. */
  destroy(): void
}

/** The client ids of a y-protocols awareness update (varUint count, then id, clock, state each). */
export function awarenessClientIds(update: Uint8Array): number[] {
  let pos = 0
  const varUint = (): number => {
    let n = 0
    let mult = 1
    for (;;) {
      const b = update[pos++]
      if (b === undefined) throw new Error('awareness update: truncated')
      n += (b & 0x7f) * mult
      if (b < 0x80) return n
      mult *= 128
      if (mult > 2 ** 53) throw new Error('awareness update: varUint too long')
    }
  }
  const ids: number[] = []
  for (let count = varUint(); count > 0; count--) {
    ids.push(varUint())
    varUint()
    pos += varUint()
    if (pos > update.length) throw new Error('awareness update: truncated')
  }
  return ids
}

function peerOf(clientId: number, state: unknown, userId: string | undefined): DocPeer | null {
  const user = (state as { user?: { name?: unknown; color?: unknown } } | null)?.user
  if (!userId || !user) return null
  return {
    clientId,
    userId,
    name: typeof user.name === 'string' ? user.name.slice(0, 64) : '',
    color:
      typeof user.color === 'string' && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#888888'
  }
}

/** `live()`: the page loaded; frames before that wait. */
export function createDocAwareness(
  doc: Y.Doc,
  channelId: string,
  pageId: string,
  deps: AwarenessDeps,
  live: () => boolean
): DocAwareness {
  const awareness = new Awareness(doc)
  let destroyed = false
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  const peerUsers = new Map<number, string>()

  const crypto = (): ReturnType<AwarenessDeps['crypto']> | null => {
    try {
      return deps.crypto()
    } catch {
      return null
    }
  }

  // Renewing the local state also keeps y-protocols from renewing it on its own clock.
  const heartbeat = setInterval(() => {
    if (live() && !destroyed) awareness.setLocalState(awareness.getLocalState())
  }, HEARTBEAT_MS)

  function sendNow(): void {
    // The null state on close goes out once more after `destroyed`.
    const leaving = awareness.getLocalState() === null
    if ((!live() && !leaving) || !deps.online()) return
    last = Date.now()
    const bytes = encodeAwarenessUpdate(awareness, [awareness.clientID])
    crypto()
      ?.encryptDoc({ channelId, pageId, kind: 'doc_awareness', bytes })
      .then((out) => deps.sendAwareness({ channelId, pageId, envelope: out.envelope }))
      .catch((e: unknown) => console.warn('[docs] awareness not sent', e))
  }

  function announce(): void {
    if (timer || destroyed) return
    const wait = last + AWARENESS_MS - Date.now()
    if (wait <= 0) return sendNow()
    timer = setTimeout(() => {
      timer = null
      sendNow()
    }, wait)
  }

  const me = deps.me()
  if (me) awareness.setLocalStateField('user', me)

  awareness.on('update', ({ added }: { added: number[] }, origin: unknown) => {
    if (origin === 'local' && awareness.getLocalState() === null) {
      if (timer) clearTimeout(timer)
      timer = null
      sendNow()
    } else if (origin === 'local' || (origin === REMOTE && added.length > 0)) announce()
  })

  awareness.on('change', () => {
    if (destroyed) return
    const peers: DocPeer[] = []
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue
      const peer = peerOf(clientId, state, peerUsers.get(clientId))
      if (peer) peers.push(peer)
    }
    deps.setPresence(pageId, peers)
  })

  return {
    awareness,
    announce,
    receive(d) {
      if (destroyed || d.deviceId === deps.deviceId()) return
      void crypto()
        ?.decryptDoc([
          {
            id: 'awareness',
            channelId,
            pageId,
            kind: 'doc_awareness',
            senderDevice: d.deviceId,
            envelope: d.envelope
          }
        ])
        .then(([r]) => {
          if (destroyed || r?.status !== 'ok') return
          const ids = awarenessClientIds(r.bytes)
          if (ids.includes(awareness.clientID)) return
          // The name shows from the state, the user id only from the verified sender.
          for (const id of ids) peerUsers.set(id, r.sender.userId)
          applyAwarenessUpdate(awareness, r.bytes, REMOTE)
        })
        .catch((e: unknown) => console.warn('[docs] awareness dropped', e))
    },
    destroy() {
      destroyed = true
      if (timer) clearTimeout(timer)
      timer = null
      clearInterval(heartbeat)
      deps.setPresence(pageId, [])
    }
  }
}
