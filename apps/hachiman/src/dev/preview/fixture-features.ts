// Preview fixtures of the Arc features (N10-N16, N21): reactions, a reply, pins, an event, custom
// statuses, threads and a page activity row. They go through the stub crypto like live data.
import type { GuildEventWithMe, Message, User } from '@hachiman/client'
import { STUB_MARKER, toB64url, type KindedContent } from '@hachiman/crypto'
import { hachiman } from '@/services/hachiman'
import { messagesService } from '@/services/MessagesService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { DAY, G1, G1C, G2, G2C, G3, G3C, ME, U, channel, groupOf, nextId, now } from './fixture'
import { PAGE } from './fixture-pages'
import { dispatch } from './stubs'

/** A stub envelope (NOT ENCRYPTED) for a ciphertext row. */
function stubEnvelope(channelId: string, clientMsgId: string, body: KindedContent<string>): string {
  const env = { ...body, marker: STUB_MARKER, channelId, clientMsgId }
  return toB64url(new TextEncoder().encode(JSON.stringify(env)))
}

/** A fixture row as the ciphertext Message that Takusen would send. */
export function stubWire(row: ChatMessage): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    guildId: row.guildId,
    author: row.author,
    senderDevice: `d-${row.author.id}`,
    groupId: row.groupId || groupOf(row.channelId),
    epoch: row.epoch,
    clientMsgId: row.clientMsgId,
    attachments: [],
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    envelope: stubEnvelope(row.channelId, row.clientMsgId, {
      kind: 'message',
      editOf: null,
      content: {
        text: row.content,
        mentions: row.mentions,
        attachments: row.attachments,
        replyTo: row.replyTo,
        sentAtMs: Date.parse(row.createdAt)
      }
    })
  }
}

const generalRows = (): ChatMessage[] =>
  (useMessageStore.getState().byChannel.get(G1C.general) ?? []).filter(
    (m) => !m.pending && m.decrypt.status === 'ok' && m.kind !== 'page_activity'
  )

/** The four pins of #general: the newest four decrypted fixture rows, newest first. */
export function fixturePinIds(): string[] {
  return generalRows()
    .slice(-4)
    .reverse()
    .map((m) => m.id)
}

/** The next Thursday 21:00 local time. */
function nextThursday21(): string {
  const d = new Date(now)
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7))
  d.setHours(21, 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 7)
  return d.toISOString()
}

export function fixtureEvents(): GuildEventWithMe[] {
  return [
    {
      id: 'ev-scrims',
      guildId: G1,
      channelId: G1C.ranked,
      title: 'Scrims',
      startsAt: nextThursday21(),
      endsAt: null,
      createdBy: U.marlowe.id,
      createdAt: new Date(now - 2 * DAY).toISOString(),
      rsvpCount: 5,
      me: true
    },
    {
      id: 'ev-dogear-talk',
      guildId: G3,
      channelId: G3C.room,
      title: 'Ch. 1–7 talk',
      startsAt: nextWednesday(),
      endsAt: null,
      createdBy: U.juniper.id,
      createdAt: new Date(now - 5 * DAY).toISOString(),
      rsvpCount: 3,
      me: false
    }
  ]
}

/** The next Wednesday 00:00 local time: a date-only event ("Wed 14"). */
function nextWednesday(): string {
  const d = new Date(now)
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7))
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** Runs `fn` once the (stub) crypto client is ready, so the fixtures decrypt on the first try. */
function whenCryptoReady(fn: () => void): void {
  if (useCryptoStore.getState().phase === 'ready') return fn()
  const stop = useCryptoStore.subscribe((s) => {
    if (s.phase !== 'ready') return
    stop()
    fn()
  })
}

/** Seeds the Arc feature fixtures. Call after the history is in the store. */
export function seedFeatureFixtures(): void {
  whenCryptoReady(seedEncryptedFixtures)
  seedPlainFixtures()
}

/** The #general row that gets the reactions, the reply and the "Bracket seeding" thread. */
function reactionTarget(): ChatMessage | undefined {
  const rows = generalRows()
  return rows.find((m) => m.content.startsWith('scrim moved to thursday')) ?? rows.at(-1)
}

/** The reactions, the reply and the page activity row: stub envelopes through the decrypt path. */
function seedEncryptedFixtures(): void {
  const target = reactionTarget()
  if (target) {
    const base = Date.parse(target.createdAt)
    const event = (author: User, minutes: number, body: KindedContent<string>): Message => {
      const id = nextId('m')
      const cmid = `cmid-${id}`
      return {
        id,
        channelId: G1C.general,
        guildId: G1,
        author,
        senderDevice: `d-${author.id}`,
        groupId: target.groupId,
        epoch: target.epoch,
        clientMsgId: cmid,
        attachments: [],
        createdAt: new Date(base + minutes * 60_000).toISOString(),
        editedAt: null,
        envelope: stubEnvelope(G1C.general, cmid, body)
      }
    }
    const react = (author: User, minutes: number, emoji: string): Message =>
      event(author, minutes, {
        kind: 'reaction',
        editOf: null,
        content: { target: target.clientMsgId, emoji, remove: false, sentAtMs: base + minutes }
      })
    void messagesService.ingest([
      react(ME, 1, '🔥'),
      react(U.juniper, 2, '🔥'),
      react(U.ozzy, 3, '👀'),
      event(U.juniper, 4, {
        kind: 'message',
        editOf: null,
        content: {
          text: 'thursday works for me, I can sub in if someone drops',
          mentions: [],
          attachments: [],
          replyTo: target.clientMsgId,
          sentAtMs: base + 4 * 60_000
        }
      })
    ])
  }

  // "yuki.h edited RFC: pages channels · 2 changes · View" in #design-pages.
  const pagesId = G2C.designPages
  const paId = nextId('m')
  void messagesService.ingest([
    {
      id: paId,
      channelId: pagesId,
      guildId: G2,
      author: U.yuki,
      senderDevice: `d-${U.yuki.id}`,
      groupId: groupOf(pagesId),
      epoch: 3,
      clientMsgId: `cmid-${paId}`,
      attachments: [],
      createdAt: new Date(now - 40 * 60_000).toISOString(),
      editedAt: null,
      envelope: stubEnvelope(pagesId, `cmid-${paId}`, {
        kind: 'page_activity',
        editOf: null,
        content: { pageId: PAGE.rfc, changes: 2, sentAtMs: now - 40 * 60_000 }
      })
    }
  ])
  useMessageStore.getState().setHasMore(pagesId, false)
}

/** Custom statuses and threads: plaintext metadata, dispatched as gateway events. */
function seedPlainFixtures(): void {
  // Custom statuses (N16). My own status echoes as the gateway would.
  const statuses: [string, string][] = [
    [U.yuki.id, '5am, watching the VOD'],
    [U.juniper.id, 'Reading chapter 6']
  ]
  for (const [userId, text] of statuses) {
    const status = hachiman.cache.presences.get(userId) ?? 'online'
    dispatch({
      t: 'PRESENCE_UPDATE',
      d: { userId, status, customStatus: { text, expiresAt: null } }
    })
  }
  hachiman.setCustomStatus = (text, expiresAt = null) => {
    const status = hachiman.cache.presences.get(ME.id) ?? 'online'
    dispatch({
      t: 'PRESENCE_UPDATE',
      d: { userId: ME.id, status, ...(text ? { customStatus: { text, expiresAt } } : {}) }
    })
  }

  // Three threads under #general (N12).
  const threads: [string, string][] = [
    ['c-no-thread-bracket', 'Bracket seeding'],
    ['c-no-thread-vod', 'VOD review: last scrim'],
    ['c-no-thread-subs', 'Subs for Thursday']
  ]
  threads.forEach(([id, name], i) => {
    dispatch({
      t: 'CHANNEL_CREATE',
      d: channel(G1, id, 'thread', name, i, {
        parentId: G1C.general,
        ownerId: ME.id,
        mlsGroupId: groupOf(G1C.general),
        threadStartMessageId: i === 0 ? (reactionTarget()?.id ?? null) : null
      })
    })
    useMessageStore.getState().setHasMore(id, false)
  })
}
