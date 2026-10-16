/**
 * Notifications outside the app window (contract §4 Push). Two paths, both behind the
 * `pushEnabled` switch of this install and the switch of each kind (`NotifyKind`):
 *  - The open app (Electron, browser) shows an OS notification for a message that pings, a poke
 *    or a call ring while the window has no focus. It has the decrypted text, which stays on
 *    this device.
 *  - A device with no gateway session gets a push from Takusen: APNs on iOS, Web Push in the
 *    browser. The sender seals the sender name and the text to the push key of each recipient
 *    device (§12.22), so the device shows them while Takusen relays only ciphertext. A DM pushes
 *    to every participant, a guild message to the users it mentions. Electron has no push
 *    service (`pushSubscribe` null).
 */
import type { PushFilters, PushKey, User } from '@hachiman/client'
import type { Mention } from '@hachiman/crypto'
import { cryptoService } from '@/services/CryptoService'
import { hachiman, hostPlatform } from '@/services/hachiman'
import type { ClientFeature } from '@/services/features'
import { messageSound } from '@/services/SoundService'
import { plainEmojiText } from '@/lib/mentions'
import { jumpToMessage, openChannelView } from '@/lib/navigation'
import { messageNotifyKind, NOTIFY_KINDS, type NotifyKind } from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
import { currentDeviceId } from '@/stores/cryptoStore'
import { notifyPrefs, usePrefsStore } from '@/stores/prefsStore'

const MAX_BODY = 200

/** The body of an OS notification: the text, cut, or a line for an attachment-only message. */
export function notificationBody(row: Pick<ChatMessage, 'content' | 'attachments'>): string {
  const text = row.content.trim()
  if (text === '') return row.attachments.length > 0 ? 'Sent an attachment' : 'New message'
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text
}

/** The page can show OS notifications itself: Electron and the browser, not the iOS WebView. */
const hasNotificationApi = (): boolean => typeof Notification !== 'undefined'

const PUSH_KINDS: readonly NotifyKind[] = ['dm', 'mention']

/**
 * The kinds that this host can notify. iOS has no OS notifications from the page: only push,
 * which carries DMs and mentions.
 */
export function notifyKinds(): readonly NotifyKind[] {
  return hasNotificationApi() ? NOTIFY_KINDS : PUSH_KINDS
}

/** The master switch and the switch of `kind`. */
export function notifyOn(kind: NotifyKind): boolean {
  const { pushEnabled, disabledNotifications } = usePrefsStore.getState()
  return pushEnabled && !disabledNotifications.includes(kind)
}

/** Shows an OS notification of `kind` while the window has no focus. */
export function showNotification(
  kind: NotifyKind,
  title: string,
  opts: { body: string; tag: string; onClick: () => void }
): void {
  if (!hasNotificationApi() || Notification.permission !== 'granted') return
  if (!notifyOn(kind) || document.hasFocus()) return
  // silent: SoundService plays the sound of the event (or the user switched it off).
  const n = new Notification(title, { body: opts.body, tag: opts.tag, silent: true })
  n.onclick = () => {
    window.focus()
    opts.onClick()
    n.close()
  }
}

/** A poke from `user` (poke.ts). */
export function notifyPoke(user: User): void {
  showNotification('poke', user.username, {
    body: 'Poked you',
    tag: `poke:${user.id}`,
    onClick: () => undefined
  })
}

/** An incoming DM call (CallRingService). */
export function notifyRing(channelId: string, callerId: string): void {
  const channel = hachiman.cache.channels.get(channelId)
  const caller = channel?.recipients?.find((u) => u.id === callerId)?.username ?? 'Someone'
  showNotification('ring', 'Incoming call', {
    body: `${caller} is calling`,
    tag: `ring:${channelId}`,
    onClick: () => channel && openChannelView(channel)
  })
}

/**
 * What Takusen filters by (§4 Push): the kinds that push, and the channels and guilds that do
 * not. A level of 'none' is quiet. A muted DM is quiet; a muted guild channel still pushes its
 * mentions, as it pings for them. ponytail: a guild at 'none' with a louder channel inside is
 * quiet as a whole; send the louder channels too when that matters.
 */
export function pushFilters(): PushFilters {
  const kinds = (['dm', 'mention'] as const).filter((k) => notifyOn(k))
  const p = notifyPrefs()
  const quiet = new Set(Object.keys(p.notify).filter((id) => p.notify[id] === 'none'))
  for (const id of p.muted) if (hachiman.cache.channels.get(id)?.guildId === null) quiet.add(id)
  return { kinds: [...kinds], quiet: [...quiet] }
}

/**
 * Brings the push target of this device in line with the switches: subscribed with a new
 * signed push key (§12.22) while a kind that pushes is on, else deleted. False: the OS refused
 * the permission.
 */
async function syncPushTarget(): Promise<boolean> {
  const pushSubscribe = hostPlatform()?.pushSubscribe
  const deviceId = currentDeviceId()
  if (!pushSubscribe || deviceId === null) return true
  const filters = pushFilters()
  if (filters.kinds.length === 0) {
    await hachiman.rest.deletePushTarget()
    return true
  }
  const { vapidPublicKey } = await hachiman.rest.getPushConfig()
  const target = await pushSubscribe(vapidPublicKey, deviceId)
  if (!target) return false
  // The Worker signs with the device MLS key: a sender checks it against the device's leaf.
  const pushKeySig = await cryptoService.client().signPushKey(target.pushKey)
  await hachiman.rest.setPushTarget({ ...target, ...filters, pushKeySig })
  return true
}

let filterTimer: ReturnType<typeof setTimeout> | undefined
/** A level or mute changed: send the filters again, once the user stops clicking. */
function queueFilterSync(): void {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    if (!notifyOn('dm') && !notifyOn('mention')) return
    hachiman.rest.setPushFilters(pushFilters()).catch((e) => console.warn('[push] filters', e))
  }, 2000)
}

const PUSH_KEYS_TTL_MS = 60_000
const pushKeyCache = new Map<string, { at: number; keys: Promise<PushKey[]> }>()

/** The push keys of a channel's recipients, kept for a minute (a burst of messages asks once). */
function pushKeys(channelId: string, userIds: string[]): Promise<PushKey[]> {
  const key = `${channelId}:${userIds.join(',')}`
  const hit = pushKeyCache.get(key)
  if (hit && Date.now() - hit.at < PUSH_KEYS_TTL_MS) return hit.keys
  const keys = hachiman.rest.getPushKeys(channelId, userIds)
  pushKeyCache.set(key, { at: Date.now(), keys })
  keys.catch(() => pushKeyCache.delete(key))
  return keys
}

const MAX_MENTION_PUSHES = 25

/**
 * The sealed push previews of a new message (§12.22): to every other participant of a DM, to
 * the mentioned users of a guild channel. The crypto Worker checks each key against the MLS
 * roster. Never throws: without previews the DM still pushes "New message".
 */
export async function sealPushPreviews(
  channelId: string,
  text: string,
  mentions: readonly Mention[],
  attachments: readonly unknown[]
): Promise<Record<string, string>> {
  try {
    const channel = hachiman.cache.channels.get(channelId)
    const me = hachiman.cache.user
    if (!channel || !me) return {}
    const userIds =
      channel.guildId === null
        ? []
        : [...new Set(mentions.flatMap((m) => (m.type === 'user' && m.id ? [m.id] : [])))]
            .filter((id) => id !== me.id)
            .slice(0, MAX_MENTION_PUSHES)
    if (channel.guildId !== null && userIds.length === 0) return {}
    const keys = await pushKeys(channelId, userIds)
    if (keys.length === 0) return {}
    const group = (channel.recipients?.length ?? 0) > 1 && channel.name ? ` · ${channel.name}` : ''
    const title =
      channel.guildId === null ? `${me.username}${group}` : `${me.username} in #${channel.name}`
    const plain = plainEmojiText(text).trim()
    const body =
      plain !== '' ? plain : attachments.length > 0 ? 'Sent an attachment' : 'New message'
    return await cryptoService
      .client()
      .sealPushPreviews(channelId, { title, body, channelId }, keys)
  } catch (e) {
    console.warn('[push] no previews for this message', e)
    return {}
  }
}

/**
 * The master switch on. Call it from a click: browsers ask for the permission only then. iOS has
 * no Notification API: `pushSubscribe` asks natively. False: the user refused.
 */
export async function enablePush(): Promise<boolean> {
  if (hasNotificationApi() && (await Notification.requestPermission()) !== 'granted') return false
  usePrefsStore.getState().setPushEnabled(true)
  if (await syncPushTarget()) return true
  usePrefsStore.getState().setPushEnabled(false)
  return false
}

export async function disablePush(): Promise<void> {
  usePrefsStore.getState().setPushEnabled(false)
  await syncPushTarget()
}

/** The switch of one kind. "Direct messages" and "Mentions" change what Takusen pushes. */
export async function setNotifyKind(kind: NotifyKind, on: boolean): Promise<boolean> {
  usePrefsStore.getState().setNotificationEnabled(kind, on)
  return kind === 'dm' || kind === 'mention' ? syncPushTarget() : true
}

let pendingOpen: string | null = null

/**
 * A tap on a push (`IPlatformService.onPushOpen`): opens the chat. On a cold start the channel
 * is not in the cache before READY, so the tap waits for it.
 */
export function openFromPush(channelId: string): void {
  const channel = hachiman.cache.channels.get(channelId)
  if (channel) {
    pendingOpen = null
    openChannelView(channel)
  } else {
    pendingOpen = channelId
  }
}

let watchingPrefs = false

export const pushFeature: ClientFeature = {
  name: 'push',
  // A token can change between launches (APNs), and a new device of this install has no target.
  onReady(): void {
    if (pendingOpen !== null) {
      // A channel that READY does not have (left, or no longer visible) opens nothing.
      const id = pendingOpen
      pendingOpen = null
      if (hachiman.cache.channels.has(id)) openFromPush(id)
    }
    if (!watchingPrefs) {
      watchingPrefs = true
      usePrefsStore.subscribe((s, p) => {
        if (s.accounts !== p.accounts) queueFilterSync()
      })
    }
    if (!notifyOn('dm') && !notifyOn('mention')) return
    syncPushTarget().catch((e) => console.error('[push] could not subscribe', e))
  },
  onMessage(_m, row, ctx): void {
    if (!row || messageSound(row, ctx, notifyPrefs()) === null) return
    showNotification(messageNotifyKind(row.guildId, ctx.mentionsMe), row.author.username, {
      body: notificationBody(row),
      tag: row.channelId,
      onClick: () => jumpToMessage({ id: row.channelId, guildId: row.guildId }, row.id)
    })
  },
  // A tap that waited for READY belongs to the account that signed out.
  reset(): void {
    pendingOpen = null
  }
}
