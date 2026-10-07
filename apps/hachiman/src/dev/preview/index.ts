// Dev-only preview mode: seeds the mirror stores with a fixture so the UI can be screenshotted
// without Takusen or a gateway. Loaded by the browser host on `?preview` (DEV builds only).
// See ../README.md.
import { cryptoService } from '@/services/CryptoService'
import { hachiman, startHachiman } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { addMembership } from '@/stores/cryptoStore'
import type { ReadState, ReadyPayload } from '@hachiman/client'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { addMentions, useUnreadStore } from '@/stores/unreadStore'
import { useNavStore } from '@/stores/navStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { usePrefsStore, type Theme } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'
import {
  DAY,
  DM1,
  DM2,
  DM3,
  DM4,
  G1,
  G1C,
  G2,
  G2C,
  G3,
  G3C,
  GDM1,
  MEMBER_COUNT,
  ME,
  QUALITY,
  READY,
  U,
  fixtureHistory,
  fixtureMembership,
  now
} from './fixture'
import { PAGE } from './fixture-pages'
import { stubAdminActions } from './admin'
import { seedFeatureFixtures } from './fixture-features'
import { dispatch, stubRest, stubVoice } from './stubs'
import { pinTab, type TabTarget } from '@/stores/tabsStore'

/** The B1 tab row (pinTab skips a tab that is already pinned). */
const PREVIEW_TABS: TabTarget[] = [
  { kind: 'channel', id: G1C.general, guildId: G1 },
  { kind: 'channel', id: G1C.lounge, guildId: G1 },
  { kind: 'page', id: G2C.designPages, guildId: G2, pageId: PAGE.rfc },
  { kind: 'dm', id: DM1, guildId: null },
  { kind: 'channel', id: G2C.standup, guildId: G2 },
  { kind: 'channel', id: 'c-no-thread-bracket', guildId: G1 }
]

export interface PreviewOptions {
  /** Show the signed-out screen instead of the seeded app. */
  signedOut?: boolean
  /** Force the transcript display mode. */
  messageDisplay?: 'cozy' | 'compact'
  /** Force the theme; preview defaults to dark so screenshots are stable. */
  theme?: Theme
}

/**
 * Point every persisted store at a preview-only key so fixture state never leaks into real dev.
 * The stores hydrated from the real keys at import, so rehydrate from the preview keys.
 */
function isolatePersistence(): void {
  const stores = [useTakusenStore, useNavStore, useVoiceStore, usePrefsStore] as const
  for (const s of stores) {
    const name = s.persist.getOptions().name
    if (!name || name.startsWith('preview:')) continue
    s.persist.setOptions({ name: `preview:${name}` })
    void s.persist.rehydrate()
  }
}

/**
 * N7 fixture: #general 3 unread from marlowe's mention on (the B1 NEW divider), #lfg 1 unread
 * with a mention, Dog-ear Club 3 mentions, the marlowe DM 2.
 */
const UNREAD: { channelId: string; unread: number; mentions: number }[] = [
  { channelId: G1C.general, unread: 3, mentions: 1 },
  { channelId: G1C.lfg, unread: 1, mentions: 1 },
  { channelId: G3C.reading, unread: 3, mentions: 3 },
  { channelId: DM1, unread: 2, mentions: 2 }
]

/**
 * Read states for every fixture text channel and DM: read to the end, except the UNREAD ones. The
 * mention pass finds nothing (the stub REST has no ciphertext), so the mention ids come from here.
 */
function previewReadStates(history: Map<string, ChatMessage[]>): {
  readStates: ReadState[]
  mentions: [string, string[]][]
} {
  const ids = [
    ...READY.guilds.flatMap((g) => g.channels.filter((c) => c.type === 'text').map((c) => c.id)),
    DM1,
    DM2
  ]
  const mentions: [string, string[]][] = []
  const readStates = ids.map((channelId): ReadState => {
    const list = history.get(channelId) ?? []
    const last = list[list.length - 1]?.id ?? null
    const spec = UNREAD.find((u) => u.channelId === channelId)
    if (!spec) {
      return { channelId, lastReadMessageId: last, unreadCount: 0, lastMessageId: last }
    }
    // The unread ones are the last `unread` messages from others: my own never count.
    const theirs = list.filter((m) => m.author.id !== ME.id)
    const tail = theirs.slice(Math.max(0, theirs.length - spec.unread))
    const readTo = tail.length > 0 ? (list[list.indexOf(tail[0]) - 1]?.id ?? null) : last
    const mine = `@${ME.username}`
    const found = [
      ...tail.filter((m) => m.content.includes(mine)),
      ...tail.filter((m) => !m.content.includes(mine)).reverse()
    ]
      .slice(0, spec.mentions)
      .map((m) => m.id)
    while (found.length < spec.mentions) found.push(`${channelId}-mention-${found.length}`)
    mentions.push([channelId, found])
    return { channelId, lastReadMessageId: readTo, unreadCount: spec.unread, lastMessageId: last }
  })
  return { readStates, mentions }
}

/** N6 fixture: the favourite DM tiles of B1 (marlowe, yuki.h, Juni, quill, the group DM). */
const FAVOURITE_DMS = [DM1, DM2, DM3, DM4, GDM1]

/** N17 fixture: seconds since each voice participant joined. Lounge started 1:24:07 ago (B1). */
const JOINED_AGO_S: Record<string, number> = {
  [ME.id]: 5047,
  [U.marlowe.id]: 4980,
  [U.juniper.id]: 3120,
  [U.ozzy.id]: 610,
  [U.quill.id]: 1260
}

/** READY with a `joinedAt` on each fixture voice state. */
function withJoinedAt(ready: ReadyPayload): ReadyPayload {
  return {
    ...ready,
    guilds: ready.guilds.map((g) => ({
      ...g,
      voiceStates: g.voiceStates.map((vs) => ({
        ...vs,
        joinedAt: new Date(now - (JOINED_AGO_S[vs.userId] ?? 300) * 1000).toISOString()
      }))
    }))
  }
}

/**
 * Seed the stores with the preview fixture and cut every network seam. Call before the first
 * render. Idempotent enough for HMR (a reload re-runs it from scratch).
 */
export function startPreview(opts: PreviewOptions = {}): void {
  isolatePersistence()
  // No gateway, no token refresh: the app never leaves this tab.
  hachiman.connect = () => {}
  hachiman.gateway.connect = () => {}
  // No Worker and no keys: envelopes are marked JSON (NOT ENCRYPTED, see createCryptoStub).
  cryptoService.useStub()
  stubAdminActions()

  usePrefsStore.getState().setTheme(opts.theme ?? 'dark')
  if (opts.messageDisplay) usePrefsStore.getState().setMessageDisplay(opts.messageDisplay)

  if (opts.signedOut) {
    useTakusenStore.setState({ session: null, pendingFlow: null })
    console.info('[preview] signed-out mode')
    return
  }

  const history = fixtureHistory()
  stubRest()
  stubVoice()
  takusenService.listRegions = async () => [
    { code: 'eu-west', displayName: 'Europe (West)', probeHost: null, probePort: 0 },
    { code: 'us-east', displayName: 'US East', probeHost: null, probePort: 0 },
    { code: 'ap-northeast', displayName: 'Asia Pacific (Tokyo)', probeHost: null, probePort: 0 }
  ]
  takusenService.recommendRegion = async () => undefined

  useTakusenStore.setState({
    session: {
      accessToken: 'preview',
      refreshToken: null,
      expiresAt: now + 365 * DAY,
      user: { id: ME.id, handle: ME.username, email: 'kestrel@example.com' }
    },
    pendingFlow: null
  })

  startHachiman() // registers the gateway → store listeners; connect() is a no-op now
  for (const [channelId, events] of fixtureMembership()) addMembership(channelId, events)
  hachiman.gateway.emit('state', 'ready')
  const unread = previewReadStates(history)
  dispatch({ t: 'READY', d: { ...withJoinedAt(READY), readStates: unread.readStates } })
  usePrefsStore.setState((s) => ({
    accounts: {
      ...s.accounts,
      [ME.id]: {
        ...(s.accounts[ME.id] ?? { notify: {}, muted: [] }),
        favouriteDms: FAVOURITE_DMS
      }
    }
  }))
  useUnreadStore.setState((s) => ({
    byChannel: unread.mentions.reduce((m, [id, ids]) => addMentions(m, id, ids), s.byChannel)
  }))
  // READY carries the fixture's voice state for me; re-echo the client's (persisted) mute/deafen.
  hachiman.setSelfVoice({})

  const msgs = useMessageStore.getState()
  for (const [channelId, list] of history) {
    useMessageStore.setState((s) => ({ byChannel: new Map(s.byChannel).set(channelId, list) }))
    msgs.setHasMore(channelId, false)
  }
  seedFeatureFixtures()
  msgs.setTyping(G1C.general, U.juniper.id, now + 3_600_000)
  msgs.setTyping(DM1, U.marlowe.id, now + 3_600_000)

  useVoiceStore.setState({
    guildId: G1,
    channelId: G1C.lounge,
    connectionState: 'connected',
    speaking: new Set([U.marlowe.id]),
    peers: [U.marlowe, U.juniper, U.ozzy].map((u, i) => ({ userId: u.id, ssrc: 1000 + i })),
    connectionQuality: QUALITY()
  })

  useNavStore.setState({
    guildKey: G1,
    channelByGuild: { [G1]: G1C.general, [G2]: G2C.standup, [G3]: G3C.reading }
  })
  useUserStore.setState({ me: ME })
  // Every load: READY prunes the thread tab (the fixture threads come after READY).
  PREVIEW_TABS.forEach((t, i) => pinTab(t, i))

  console.info(
    '[preview] seeded: %d guilds, %d members, me = %s',
    READY.guilds.length,
    MEMBER_COUNT,
    ME.username
  )
}
