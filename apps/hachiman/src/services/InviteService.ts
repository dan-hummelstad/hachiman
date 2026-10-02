import type { CreateGuildBody, GuildFull, Invite, InvitePreview } from '@hachiman/client'
import { hachiman } from '@/services/hachiman'
import { oracleService } from '@/services/OracleService'
import { selectGuild } from '@/stores/navStore'

// Invite-code shape the clients accept. Oracle issues 8-char codes (apps/oracle/src/lib/invites.ts)
// and is the authority; this stays looser so a bad code gets Oracle's "Unknown invite" answer.
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

/** Shareable link: Oracle's public `/invite/<code>` landing page, on the issuer origin (same origin apiBase defaults to). */
export function inviteUrl(code: string): string {
  return `${oracleService.env.issuerOrigin}/invite/${encodeURIComponent(code)}`
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
  /** Seconds until it expires. */
  expiry: number
  maxUses: number
}

/** 7 days, unlimited uses. Shared by InviteDialog and the Invites tab. */
export const DEFAULT_INVITE_OPTIONS: InviteOptionsValue = { expiry: 604800, maxUses: 0 }

export function createInvite(guildId: string, o: InviteOptionsValue): Promise<Invite> {
  return hachiman.rest.createInvite(guildId, {
    maxAgeSeconds: o.expiry || undefined,
    maxUses: o.maxUses || undefined
  })
}
