import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Permissions, has, type Channel, type GatewayEvents, type Invite } from '@hachiman/client'
import { countActiveInvites, inviteScope, sortInvites } from '@/components/settings/invites'
import { useInviteCreation } from '@/components/settings/use-invite-creation'
import type { Action } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { errMsg } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import {
  addGuildInvite,
  copyLinkFromTap,
  createHistoryInvite,
  createInvite,
  guildInviteList,
  inviteUrl,
  loadGuildInvites,
  revokeGuildInvite,
  subscribeGuildInviteLists,
  type InviteOptionsValue
} from '@/services/InviteService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'

const NO_INVITES: Invite[] = []
const NO_CHANNELS: Channel[] = []

/** What the user may do on the Invites page of a guild. */
export function useInvitePermissions(guildId: string): {
  /** MANAGE_GUILD: list and revoke the invites. */
  canList: boolean
  /** CREATE_INSTANT_INVITE. */
  canCreate: boolean
  /** ADMINISTRATOR: long and permanent invites, and invites with history. */
  isAdmin: boolean
} {
  const perms = usePermissions(guildId)
  return {
    canList: has(perms, Permissions.MANAGE_GUILD),
    canCreate: has(perms, Permissions.CREATE_INSTANT_INVITE),
    isAdmin: has(perms, Permissions.ADMINISTRATOR)
  }
}

export interface GuildInvites {
  /** Permanent first, then newest first. */
  invites: readonly Invite[]
  /** The "now" of the expiry states: when the list was loaded or last changed. */
  now: number
  /** Shows a new invite first. */
  add: (invite: Invite) => void
  /** DELETE /invites/:code (MANAGE_GUILD), then drops it. Rejects with the REST error. */
  revoke: (code: string) => Promise<void>
}

/**
 * The invites of the Invites page. With MANAGE_GUILD (`canList`) they come from the module cache
 * of the guild (`loadGuildInvites` in services/InviteService), which the mobile tab count also
 * reads, and the page loads it again on each open. Without it, the list holds only the links that
 * the user made on this page. `onError` gets a load failure as a user-facing line.
 */
export function useGuildInvites(
  guildId: string,
  canList: boolean,
  onError: (message: string) => void
): GuildInvites {
  const listed = useSyncExternalStore(subscribeGuildInviteLists, () =>
    canList ? guildInviteList(guildId) : undefined
  )
  const [mountedAt] = useState(Date.now)
  const [own, setOwn] = useState<Invite[]>(NO_INVITES)

  useEffect(() => {
    if (!canList) return
    loadGuildInvites(guildId).catch((e: unknown) =>
      onError(`Could not load invites: ${errMsg(e)}. Reopen settings to retry.`)
    )
  }, [guildId, canList, onError])

  // A revoked link of my own leaves the list (the cache follows INVITE_DELETE by itself).
  useEffect(() => {
    const onDelete = (d: GatewayEvents['INVITE_DELETE']): void => {
      if (d.guildId === guildId) setOwn((cur) => cur.filter((i) => i.code !== d.code))
    }
    hachiman.on('INVITE_DELETE', onDelete)
    return () => {
      hachiman.off('INVITE_DELETE', onDelete)
    }
  }, [guildId])

  const source = canList ? (listed?.invites ?? NO_INVITES) : own
  const invites = useMemo(() => sortInvites(source), [source])

  return {
    invites,
    now: canList ? (listed?.at ?? mountedAt) : mountedAt,
    add: (invite) => (canList ? addGuildInvite(invite) : setOwn((cur) => [invite, ...cur])),
    revoke: async (code) => {
      await revokeGuildInvite(guildId, code)
      setOwn((cur) => cur.filter((i) => i.code !== code))
    }
  }
}

/**
 * The count of the Invites tab (M52, M55): the invites of the guild that still let people join.
 * Loads the list while `guildId` is set; pass null without MANAGE_GUILD. Undefined until loaded.
 */
export function useActiveInviteCount(guildId: string | null): number | undefined {
  const listed = useSyncExternalStore(subscribeGuildInviteLists, () =>
    guildId ? guildInviteList(guildId) : undefined
  )
  useEffect(() => {
    // The Invites page shows a load error; the count stays empty.
    if (guildId) loadGuildInvites(guildId).catch(() => undefined)
  }, [guildId])
  return listed && countActiveInvites(listed.invites, listed.at)
}

/** A new invite of the create bar. */
export interface CreatedInvite {
  invite: Invite
  /** The seed of an invite with history: only in component state and the link (§12.17). */
  key: string | null
  /** An invite with history: the `#names` of the channels whose history the record signs. */
  scope: string[]
  /** `copyInTap`: the copy of the link that the tap started (`copyLinkFromTap`). Else null. */
  copied: Promise<boolean> | null
  /** An invite with history for which this device sent nothing: it holds no group of the scope. */
  noOwnHistory: boolean
}

/**
 * The create form of the Invites page: the options, the permanent-invite gate
 * (`useInviteCreation`) and, for an administrator, "Include history" with its scope (§12.11.4).
 * `copyInTap` starts the copy of the new link inside the tap (WebKit, M55); without it, the
 * caller copies in `onCreated`. `what` names the action in the error text.
 */
export function useInviteCreateForm({
  guildId,
  isAdmin,
  run,
  copyInTap,
  what = 'create an invite',
  onCreated
}: {
  guildId: string
  isAdmin: boolean
  run: Action['run']
  copyInTap: boolean
  what?: string
  onCreated: (created: CreatedInvite) => void
}): ReturnType<typeof useInviteCreation<CreatedInvite>> & {
  /** The channels an invite with history opens: the text and pages channels @everyone views. */
  scope: Channel[]
  /** Include history is on, and can be (an administrator, a scope that is not empty). */
  history: boolean
  setHistory: (on: boolean) => void
} {
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const channels = useChannelStore((s) => s.channels)
  const [includeHistory, setIncludeHistory] = useState(false)
  const scope = useMemo(
    () => (guild && roles ? inviteScope(guild, roles, channels.values()) : NO_CHANNELS),
    [guild, roles, channels]
  )
  // The user can lose ADMINISTRATOR, and the last channel can leave the scope, while it is open.
  const history = isAdmin && includeHistory && scope.length > 0

  const make = async (
    o: InviteOptionsValue,
    acknowledgedPermanent: boolean
  ): Promise<CreatedInvite> => {
    if (!history) {
      const invite = await createInvite(guildId, o, acknowledgedPermanent)
      return { invite, key: null, scope: [], copied: null, noOwnHistory: false }
    }
    const made = await createHistoryInvite(
      guildId,
      o,
      scope.map((c) => c.id),
      acknowledgedPermanent
    )
    // The signed scope is a subset of the input, in byte order: show it in sidebar order.
    const signed = new Set(made.channelIds)
    return {
      invite: made.invite,
      key: made.key,
      scope: scope.filter((c) => signed.has(c.id)).map((c) => `#${c.name ?? c.id}`),
      copied: null,
      noOwnHistory: made.groups === 0
    }
  }

  const creation = useInviteCreation<CreatedInvite>({
    isAdmin,
    run,
    what,
    // `useInviteCreation` calls `make` inside the tap of Create (or of the permanent confirm),
    // before any await, so the clipboard write starts in the gesture.
    make: copyInTap
      ? (o, ack): Promise<CreatedInvite> => {
          const made = make(o, ack)
          const copied = copyLinkFromTap(made.then((m) => inviteUrl(m.invite.code, m.key)))
          return made.then((m) => ({ ...m, copied }))
        }
      : make,
    onCreated
  })

  const setHistory = (on: boolean): void => {
    setIncludeHistory(on)
    // An invite with history has one use by default (§12.11.4).
    if (on) creation.setOptions({ ...creation.options, maxUses: 1 })
  }

  return { ...creation, scope, history, setHistory }
}
