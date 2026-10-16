/**
 * Notifications outside the app window (contract §4 Push). Two paths, both behind the
 * `pushEnabled` switch of this install and the switch of each kind (`NotifyKind`):
 *  - The open app (Electron, browser) shows an OS notification for a message that pings, a poke
 *    or a call ring while the window has no focus. It has the decrypted text, which stays on
 *    this device.
 *  - A device with no gateway session gets a content-free push from Takusen, for DMs only: APNs
 *    on iOS, Web Push in the browser. Electron has no push service (`pushSubscribe` null).
 */
import type { User } from '@hachiman/client'
import { hachiman, hostPlatform } from '@/services/hachiman'
import type { ClientFeature } from '@/services/features'
import { messageSound } from '@/services/SoundService'
import { jumpToMessage, openChannelView } from '@/lib/navigation'
import { messageNotifyKind, NOTIFY_KINDS, type NotifyKind } from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
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

/**
 * The kinds that this host can notify. iOS has no OS notifications from the page, and its push
 * carries DMs only.
 */
export function notifyKinds(): readonly NotifyKind[] {
  return hasNotificationApi() ? NOTIFY_KINDS : ['dm']
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
 * Brings the push target of this device in line with the switches: subscribed while the master
 * switch and "Direct messages" are on (Takusen pushes only DMs), else deleted. False: the OS
 * refused the permission.
 */
async function syncPushTarget(): Promise<boolean> {
  const pushSubscribe = hostPlatform()?.pushSubscribe
  if (!pushSubscribe) return true
  if (!notifyOn('dm')) {
    await hachiman.rest.deletePushTarget()
    return true
  }
  const { vapidPublicKey } = await hachiman.rest.getPushConfig()
  const target = await pushSubscribe(vapidPublicKey)
  if (!target) return false
  await hachiman.rest.setPushTarget(target)
  return true
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

/** The switch of one kind. Only "Direct messages" changes the push target. */
export async function setNotifyKind(kind: NotifyKind, on: boolean): Promise<boolean> {
  usePrefsStore.getState().setNotificationEnabled(kind, on)
  return kind === 'dm' ? syncPushTarget() : true
}

export const pushFeature: ClientFeature = {
  name: 'push',
  // A token can change between launches (APNs), and a new device of this install has no target.
  onReady(): void {
    if (!notifyOn('dm')) return
    syncPushTarget().catch((e) => console.error('[push] could not subscribe', e))
  },
  onMessage(_m, row, ctx): void {
    if (!row || messageSound(row, ctx, notifyPrefs()) === null) return
    showNotification(messageNotifyKind(row.guildId, ctx.mentionsMe), row.author.username, {
      body: notificationBody(row),
      tag: row.channelId,
      onClick: () => jumpToMessage({ id: row.channelId, guildId: row.guildId }, row.id)
    })
  }
}
