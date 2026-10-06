import type { CreateGuildBody, GuildFull, Invite, InvitePreview } from '@hachiman/client'
import { hachiman } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { selectGuild } from '@/stores/navStore'

// Invite-code shape the clients accept. Takusen issues 8-char codes (apps/takusen/src/lib/invites.ts)
// and is the authority; this stays looser so a bad code gets Takusen's "Unknown invite" answer.
// Electron main can't import this package and keeps a copy of the same bounds in
// apps/hachiman-electron/src/main/protocol-handler.ts.
const CODE = '[A-Za-z0-9_-]{2,64}'
const BARE_CODE_RE = new RegExp(`^(${CODE})$`)
const INVITE_LINK_RE = new RegExp(`^(?:takusen://|https?://[^/]+/)invite/(${CODE})/?(?:[?#].*)?$`)

/**
 * Invite code from `takusen://invite/<code>`, `https://<host>/invite/<code>`, or a bare code.
 * Returns null when the input doesn't look like any of those.
 */
export function parseInviteCode(input: string): string | null {
  const s = input.trim()
  return (BARE_CODE_RE.exec(s) ?? INVITE_LINK_RE.exec(s))?.[1] ?? null
}

export function previewInvite(code: string): Promise<InvitePreview> {
  return hachiman.rest.previewInvite(code)
}

/** Join the guild (idempotent server-side) and select it. */
export async function acceptInvite(code: string): Promise<GuildFull> {
  const guild = await hachiman.rest.acceptInvite(code)
  selectGuild(guild.id)
  return guild
}

/** Create a guild (owned by the current user) and select it, like joining one does. */
export async function createGuild(body: CreateGuildBody): Promise<GuildFull> {
  const guild = await hachiman.rest.createGuild(body)
  selectGuild(guild.id)
  return guild
}

/** Shareable link: Takusen's public `/invite/<code>` landing page, on the issuer origin (same origin apiBase defaults to). */
export function inviteUrl(code: string): string {
  return `${takusenService.env.issuerOrigin}/invite/${encodeURIComponent(code)}`
}

/** Copy the invite's link; rejects with a user-facing message. */
export async function copyInviteLink(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl(code))
  } catch {
    throw new Error('Could not copy to the clipboard. Select the link and copy it by hand.')
  }
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
 * permanent invite (`expiry` 0) without it.
 */
export function createInvite(
  guildId: string,
  o: InviteOptionsValue,
  acknowledgedPermanent = false
): Promise<Invite> {
  return hachiman.rest.createInvite(guildId, {
    maxAgeSeconds: o.expiry,
    maxUses: o.maxUses || undefined,
    acknowledgedPermanent: o.expiry === 0 ? acknowledgedPermanent : undefined
  })
}
