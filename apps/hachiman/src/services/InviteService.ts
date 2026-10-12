import type { CreateGuildBody, GuildFull, Invite, InvitePreview } from '@hachiman/client'
import { CryptoError, INVITE_BUNDLE_FETCH_WINDOW_MS } from '@hachiman/crypto'
import { inviteKeyFragment } from '@/lib/invite-link'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import { takusenService } from '@/services/TakusenService'
import { pushInviteHistoryFailure } from '@/stores/cryptoStore'
import { selectGuild } from '@/stores/navStore'

export function previewInvite(code: string): Promise<InvitePreview> {
  return hachiman.rest.previewInvite(code)
}

// MARK: - invite keys (contract §12.17: the seed of an invite with history)

/**
 * Invite code → the key (`#k=`) of the link that opened it, until the join. Memory only: never a
 * store, never localStorage.
 */
const linkKeys = new Map<string, string>()

/** A join that waits to redeem the history: for the Worker, the guild in the cache, or a retry. */
interface Waiting {
  guildId: string
  key: string
  /** Date.now() at the join. Takusen serves the bundles INVITE_BUNDLE_FETCH_WINDOW_MS after it. */
  joinedAt: number
  /** Transport errors so far: they set the wait before the next try. */
  failures: number
}
/** Invite code → its waiting join. */
const waiting = new Map<string, Waiting>()
/** The wait after the first transport error. It doubles with each error, to REDEEM_RETRY_MAX_MS. */
const REDEEM_RETRY_MS = 5_000
const REDEEM_RETRY_MAX_MS = 5 * 60_000
let retry: { at: number; timer: ReturnType<typeof setTimeout> } | null = null

const SIGN_IN_KEY_PREFIX = 'hachiman-invite-key:'
const signInKey = (code: string): string => `${SIGN_IN_KEY_PREFIX}${code}`

/** Keeps the key of an opened invite link for the join window. Null forgets it. */
export function stashInviteKey(code: string, key: string | null): void {
  if (key === null) linkKeys.delete(code)
  else linkKeys.set(code, key)
}

export function peekInviteKey(code: string): string | null {
  return linkKeys.get(code) ?? null
}

/**
 * Browser sign-in: the same-tab redirect loads the page again, so the key waits in sessionStorage
 * (this tab only) until restoreInviteKey. The Electron renderer keeps its memory.
 */
export function keepInviteKeyForSignIn(code: string, key: string): void {
  try {
    sessionStorage.setItem(signInKey(code), key)
  } catch {
    // No sessionStorage: after the redirect the join window asks for the full link again.
  }
}

/** After the sign-in callback: moves a key that keepInviteKeyForSignIn kept back into memory. */
export function restoreInviteKey(code: string): void {
  let key: string | null = null
  try {
    key = sessionStorage.getItem(signInKey(code))
    sessionStorage.removeItem(signInKey(code))
  } catch {
    return
  }
  if (key !== null) stashInviteKey(code, key)
}

/**
 * Browser start-up, after the OAuth callback of the load URL (if any) ran restoreInviteKey: removes
 * every key that a sign-in kept and did not use (the user left the sign-in page, for example). Thus
 * a key stays in sessionStorage only across one redirect (§12.17).
 */
export function dropSignInInviteKeys(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k?.startsWith(SIGN_IN_KEY_PREFIX)) sessionStorage.removeItem(k)
    }
  } catch {
    // No sessionStorage: it holds no key.
  }
}

/**
 * Join the guild (idempotent server-side) and select it. With the key of an invite with history,
 * the crypto Worker then opens the history (redeemWaitingInvites).
 */
export async function acceptInvite(code: string, key: string | null = null): Promise<GuildFull> {
  stashInviteKey(code, null)
  const guild = await hachiman.rest.acceptInvite(code)
  selectGuild(guild.id)
  if (key !== null) {
    waiting.set(code, { guildId: guild.id, key, joinedAt: Date.now(), failures: 0 })
    redeemWaitingInvites()
  }
  return guild
}

/**
 * Redeems each waiting invite once the Worker is ready and the client cache has the members of its
 * guild (§12.11.4 "Redeemer checks"). hachiman.ts calls it again when encryption becomes ready, and
 * on READY and GUILD_CREATE. A failure loses only the history: the user stays a member, and a
 * security notice tells them.
 */
export function redeemWaitingInvites(): void {
  const me = hachiman.cache.user?.id
  if (me === undefined || !cryptoService.ready) return
  for (const [code, w] of waiting) {
    if (!hachiman.cache.members.get(w.guildId)?.has(me)) continue
    waiting.delete(code)
    cryptoService
      .client()
      .redeemInvite({ code, linkSecret: w.key })
      .then(
        (r) => console.info('[invite] %s: %d history keys of %d groups', code, r.keys, r.groups),
        (e: unknown) => onRedeemError(code, w, e)
      )
  }
}

function onRedeemError(code: string, w: Waiting, e: unknown): void {
  // Another join with this code waits already.
  if (waiting.has(code)) return
  // The Worker does not see the guild members yet: wait for the next GUILD_CREATE.
  if (e instanceof CryptoError && e.code === 'GroupPending') {
    waiting.set(code, w)
    return
  }
  // A network error, a 5xx or a 429. This memory holds the only copy of the key, and the use of
  // the invite is gone: try again while Takusen serves the bundles. 404 UnknownInvite is final.
  const wait = Math.min(REDEEM_RETRY_MS * 2 ** w.failures, REDEEM_RETRY_MAX_MS)
  if (
    e instanceof CryptoError &&
    e.code === 'Transport' &&
    e.dsCode !== 'UnknownInvite' &&
    Date.now() + wait < w.joinedAt + INVITE_BUNDLE_FETCH_WINDOW_MS
  ) {
    waiting.set(code, { ...w, failures: w.failures + 1 })
    retryIn(wait)
    return
  }
  console.warn('[invite] %s: could not open the history', code, e)
  pushInviteHistoryFailure(w.guildId)
}

/** One timer for all waiting joins: the earliest retry wins. */
function retryIn(ms: number): void {
  const at = Date.now() + ms
  if (retry !== null) {
    if (retry.at <= at) return
    clearTimeout(retry.timer)
  }
  retry = {
    at,
    timer: setTimeout(() => {
      retry = null
      redeemWaitingInvites()
    }, ms)
  }
}

/** Sign-out: forget the keys, the waiting redemptions and the invite lists. */
export function resetInvites(): void {
  linkKeys.clear()
  waiting.clear()
  if (retry !== null) clearTimeout(retry.timer)
  retry = null
  inviteLists.clear()
  inviteLoads.clear()
  loadedAt.clear()
  notifyInviteLists()
}

// MARK: - the invite list of a guild (MANAGE_GUILD)

/** The invites of a guild, as GET /guilds/:id/invites gave them, with this client's changes. */
export interface GuildInviteList {
  /** Permanent first, then newest first (the server order; a new invite goes first). */
  invites: readonly Invite[]
  /**
   * Date.now() at the last load or change. The expiry states count from it, so the tab count and
   * the list agree.
   */
  at: number
}

/** Guild id → its invite list. Only a user with MANAGE_GUILD loads one. */
const inviteLists = new Map<string, GuildInviteList>()
const inviteListeners = new Set<() => void>()
/** Guild id → the load in flight. */
const inviteLoads = new Map<string, Promise<void>>()
/** Guild id → Date.now() at the end of its last load. */
const loadedAt = new Map<string, number>()
/** The tab count and the list mount together: a list loaded this recently is not loaded again. */
const INVITE_LIST_FRESH_MS = 10_000
let deletesWatched = false

function notifyInviteLists(): void {
  for (const listener of inviteListeners) listener()
}

function putInviteList(guildId: string, invites: readonly Invite[]): void {
  inviteLists.set(guildId, { invites, at: Date.now() })
  notifyInviteLists()
}

/** Revoked invites leave every loaded list (`INVITE_DELETE` → guild, contract §4 Invite limits). */
function watchInviteDeletes(): void {
  if (deletesWatched) return
  deletesWatched = true
  hachiman.on('INVITE_DELETE', (d) => dropGuildInvite(d.guildId, d.code))
}

/** The loaded invite list of a guild, or undefined. The same object until the list changes. */
export function guildInviteList(guildId: string): GuildInviteList | undefined {
  return inviteLists.get(guildId)
}

/** For `useSyncExternalStore`: calls `listener` on each change of any invite list. */
export function subscribeGuildInviteLists(listener: () => void): () => void {
  inviteListeners.add(listener)
  return () => {
    inviteListeners.delete(listener)
  }
}

/**
 * Loads the invites of a guild (MANAGE_GUILD) into its list. A load in flight, or one that ended
 * less than 10 s ago, is not started again. Rejects with the REST error.
 */
export function loadGuildInvites(guildId: string): Promise<void> {
  watchInviteDeletes()
  const pending = inviteLoads.get(guildId)
  if (pending) return pending
  const last = loadedAt.get(guildId)
  if (last !== undefined && Date.now() - last < INVITE_LIST_FRESH_MS) return Promise.resolve()
  const load = hachiman.rest
    .getInvites(guildId)
    .then((invites) => {
      // A sign-out during the load cleared the loads: keep nothing.
      if (inviteLoads.get(guildId) !== load) return
      loadedAt.set(guildId, Date.now())
      putInviteList(guildId, invites)
    })
    .finally(() => {
      if (inviteLoads.get(guildId) === load) inviteLoads.delete(guildId)
    })
  inviteLoads.set(guildId, load)
  return load
}

/** Puts a new invite first in the list of its guild. */
export function addGuildInvite(invite: Invite): void {
  const cur = inviteLists.get(invite.guildId)?.invites ?? []
  putInviteList(invite.guildId, [invite, ...cur.filter((i) => i.code !== invite.code)])
}

function dropGuildInvite(guildId: string, code: string): void {
  const cur = inviteLists.get(guildId)
  if (cur?.invites.some((i) => i.code === code)) {
    putInviteList(
      guildId,
      cur.invites.filter((i) => i.code !== code)
    )
  }
}

/** Revokes an invite (MANAGE_GUILD) and drops it from the list. Rejects with the REST error. */
export async function revokeGuildInvite(guildId: string, code: string): Promise<void> {
  await hachiman.rest.deleteInvite(code)
  dropGuildInvite(guildId, code)
}

// MARK: - guilds and invites

/** Create a guild (owned by the current user) and select it, like joining one does. */
export async function createGuild(body: CreateGuildBody): Promise<GuildFull> {
  const guild = await hachiman.rest.createGuild(body)
  selectGuild(guild.id)
  return guild
}

/**
 * Shareable link: Takusen's public `/invite/<code>` landing page, on the issuer origin (same origin
 * apiBase defaults to). `key`: the seed of an invite with history, in the fragment (§12.11.4).
 */
export function inviteUrl(code: string, key: string | null = null): string {
  const url = `${takusenService.env.issuerOrigin}/invite/${encodeURIComponent(code)}`
  return key === null ? url : url + inviteKeyFragment(key)
}

/**
 * Copy the invite's link; rejects with a user-facing message. The write starts before the first
 * await, so a call inside a tap keeps the gesture that WebKit asks for.
 */
export async function copyInviteLink(code: string, key: string | null = null): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl(code, key))
  } catch {
    throw new Error('Could not copy to the clipboard. Select the link and copy it by hand.')
  }
}

/**
 * Copies a link that the tap has only started to make, such as the link of a new invite. WebKit
 * writes to the clipboard only inside a tap, and the invite comes after awaits. So call this
 * inside the tap: the write starts at once, with a `ClipboardItem` whose text waits for `link`.
 * With no `ClipboardItem`, it writes the text when `link` resolves. Resolves true when the link is
 * on the clipboard, false when the copy or `link` failed. It never rejects.
 */
export function copyLinkFromTap(link: Promise<string>): Promise<boolean> {
  // A failed `link` fails the copy below; this keeps it from also being an unhandled rejection.
  link.catch(() => undefined)
  try {
    const clipboard = navigator.clipboard
    if (typeof ClipboardItem !== 'undefined' && typeof clipboard?.write === 'function') {
      const blob = link.then((text) => new Blob([text], { type: 'text/plain' }))
      blob.catch(() => undefined)
      return clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(
        () => true,
        () => false
      )
    }
  } catch {
    // No clipboard, or a `ClipboardItem` that takes no promise: write the text when it is ready.
  }
  return link
    .then((text) => navigator.clipboard.writeText(text))
    .then(
      () => true,
      () => false
    )
}

/** What a new invite link allows. 0 = no limit, for both fields. */
export interface InviteOptionsValue {
  /** Seconds until it expires. 0 = permanent (administrators only). */
  expiry: number
  maxUses: number
}

/** 24 hours, unlimited uses: allowed for every member. Shared by InviteDialog and the Invites tab. */
export const DEFAULT_INVITE_OPTIONS: InviteOptionsValue = { expiry: 86400, maxUses: 0 }

/**
 * `acknowledgedPermanent`: the user accepted the permanent-invite warning. Takusen rejects a
 * permanent invite (`expiry` 0) without it. `record`: the signed record of an invite with history.
 */
export function createInvite(
  guildId: string,
  o: InviteOptionsValue,
  acknowledgedPermanent = false,
  record?: string
): Promise<Invite> {
  return hachiman.rest.createInvite(guildId, {
    maxAgeSeconds: o.expiry,
    maxUses: o.maxUses || undefined,
    acknowledgedPermanent: o.expiry === 0 ? acknowledgedPermanent : undefined,
    record
  })
}

/** A new invite with history. `key` goes only into the link: keep it in component state. */
export interface HistoryInvite {
  invite: Invite
  key: string
  /** The scope that the record signs: the input channels that @everyone views (§12.11.4). */
  channelIds: string[]
  /**
   * The groups whose history this device sent. 0: this device holds no group of the scope (no
   * messages yet, for example), so the link gives only the history that other members send.
   */
  groups: number
}

/**
 * An invite with history (§12.11.4): the Worker signs the record of `channelIds`, Takusen makes the
 * invite, then this device sends its bundles. When a bundle fails, it revokes the invite, so no
 * link without the history of this device stays.
 */
export async function createHistoryInvite(
  guildId: string,
  o: InviteOptionsValue,
  channelIds: string[],
  acknowledgedPermanent = false
): Promise<HistoryInvite> {
  const crypto = cryptoService.client()
  const prepared = await crypto.prepareHistoryInvite({
    guildId,
    channelIds,
    expiresAtMs: o.expiry === 0 ? 0 : Date.now() + o.expiry * 1000,
    maxUses: o.maxUses
  })
  const invite = await createInvite(guildId, o, acknowledgedPermanent, prepared.record)
  let sent: { groups: number }
  try {
    sent = await crypto.sendInviteBundles({ guildId, inviteId: invite.id, record: prepared.record })
  } catch (e) {
    await hachiman.rest.deleteInvite(invite.code).catch((err: unknown) => {
      console.warn('[invite] could not revoke %s', invite.code, err)
    })
    console.warn('[invite] could not send the history of %s', invite.code, e)
    throw new Error('This device could not send the history of these channels. Try again.')
  }
  return { invite, key: prepared.linkSecret, channelIds: prepared.channelIds, groups: sent.groups }
}
