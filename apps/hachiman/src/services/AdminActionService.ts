/**
 * Signed admin actions (§12.16, Phase 4). Each wrapper signs the change with
 * CryptoApi.signAdminAction and sends the result in X-Hachiman-Signed-Action on the matching
 * route. Use these instead of the raw RestClient methods for roles, overwrites, member roles and
 * channel history visibility.
 *
 * - The guild owner's client writes the genesis action after POST /guilds (`createGuild`), as a
 *   PATCH /guilds/:id with no other change.
 * - A guild without a genesis: the owner writes it first, then the action. Another member sends
 *   the request unsigned: the REST state applies until the owner signs (§12.16 "Client check").
 * - 409 AdminActionConflict (another action took the seq): sign again once with the new head.
 * - A signed payload must state the same change as the request, or Takusen rejects it. Thus the
 *   payloads here use the values that the routes compare (for example position 1 for a new role).
 */
import {
  RestError,
  type CreateGuildBody,
  type CreateRoleBody,
  type GuildFull,
  type OverwriteBody,
  type Role,
  type RolePosition,
  type UpdateChannelBody,
  type UpdateMemberBody,
  type UpdateRoleBody
} from '@hachiman/client'
import { AdminActionType, CryptoError, type AdminPayload } from '@hachiman/crypto'
import { encodeAdminPayload } from '@/lib/admin-payload'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'

/** The position that POST /guilds/:id/roles gives a new role. */
const NEW_ROLE_POSITION = 1

const isUnsupported = (e: unknown): boolean => e instanceof CryptoError && e.code === 'Unsupported'
const isConflict = (e: unknown): boolean =>
  e instanceof RestError && e.code === 'AdminActionConflict'

function guildOfChannel(channelId: string): string {
  const guildId = hachiman.cache.channels.get(channelId)?.guildId
  if (!guildId) throw new Error('Only guild channels have signed admin actions.')
  return guildId
}

const isOwner = (guildId: string): boolean => {
  const me = hachiman.cache.user?.id
  return me !== undefined && hachiman.cache.guilds.get(guildId)?.ownerId === me
}

async function sign(guildId: string, payload: AdminPayload): Promise<string> {
  const { header } = await cryptoService
    .client()
    .signAdminAction(guildId, payload.type, encodeAdminPayload(payload))
  return header
}

/**
 * The header for `payload`, or undefined when the request goes unsigned (no genesis, and I am not
 * the owner). Any other failure rejects: a change is never sent unsigned to a signed chain.
 */
async function headerFor(guildId: string, payload: AdminPayload): Promise<string | undefined> {
  try {
    return await sign(guildId, payload)
  } catch (e) {
    // The Worker throws Unsupported for a guild without a genesis action.
    if (!isUnsupported(e)) throw e
    if (!isOwner(guildId)) return undefined
    await adminActionService.writeGenesis(guildId)
    return sign(guildId, payload)
  }
}

async function signed<T>(
  guildId: string,
  payload: AdminPayload,
  send: (signedAction: string | undefined) => Promise<T>
): Promise<T> {
  try {
    return await send(await headerFor(guildId, payload))
  } catch (e) {
    if (!isConflict(e)) throw e
    return send(await headerFor(guildId, payload))
  }
}

export const adminActionService = {
  /** POST /guilds, then the genesis action. A failed genesis is written again before the next action. */
  async createGuild(body: CreateGuildBody): Promise<GuildFull> {
    const guild = await hachiman.rest.createGuild(body)
    await adminActionService
      .writeGenesis(guild.id, guild.ownerId)
      .catch((e: unknown) => console.warn('[admin] genesis failed', e))
    return guild
  },

  /** The owner's genesis action (seq 0). A no-op when the guild already has one. */
  async writeGenesis(
    guildId: string,
    ownerId = hachiman.cache.guilds.get(guildId)?.ownerId
  ): Promise<void> {
    if (!ownerId) throw new Error('Unknown guild owner.')
    let header: string
    try {
      header = await sign(guildId, { type: AdminActionType.GENESIS, ownerId })
    } catch (e) {
      if (isUnsupported(e)) return // the chain exists
      throw e
    }
    try {
      await hachiman.rest.updateGuild(guildId, {}, { signedAction: header })
    } catch (e) {
      // Another device of the owner wrote it first.
      if (!isConflict(e)) throw e
    }
  },

  createRole(guildId: string, body: CreateRoleBody): Promise<Role> {
    // The signed payload names the role id, and Takusen creates the role with it.
    const roleId = crypto.randomUUID()
    return signed(
      guildId,
      {
        type: AdminActionType.ROLE_CREATE,
        roleId,
        permissions: body.permissions ?? 0,
        position: NEW_ROLE_POSITION
      },
      (signedAction) => hachiman.rest.createRole(guildId, body, { signedAction })
    )
  },

  /** Only a permissions change is signed; a name or color change is plain REST. */
  updateRole(guildId: string, roleId: string, body: UpdateRoleBody): Promise<Role> {
    const permissions = body.permissions
    if (permissions === undefined) return hachiman.rest.updateRole(guildId, roleId, body)
    const role = hachiman.cache.roles.get(guildId)?.get(roleId)
    if (!role) return Promise.reject(new Error('Unknown role.'))
    return signed(
      guildId,
      { type: AdminActionType.ROLE_UPDATE, roleId, permissions, position: role.position },
      (signedAction) => hachiman.rest.updateRole(guildId, roleId, body, { signedAction })
    )
  },

  deleteRole(guildId: string, roleId: string): Promise<void> {
    return signed(guildId, { type: AdminActionType.ROLE_DELETE, roleId }, (signedAction) =>
      hachiman.rest.deleteRole(guildId, roleId, { signedAction })
    )
  },

  reorderRoles(guildId: string, positions: RolePosition[]): Promise<Role[]> {
    return signed(
      guildId,
      {
        type: AdminActionType.ROLE_REORDER,
        positions: positions.map((p) => ({ roleId: p.id, position: p.position }))
      },
      (signedAction) => hachiman.rest.reorderRoles(guildId, positions, { signedAction })
    )
  },

  putOverwrite(channelId: string, targetId: string, body: OverwriteBody): Promise<void> {
    return signed(
      guildOfChannel(channelId),
      {
        type: AdminActionType.OVERWRITE_PUT,
        channelId,
        targetId,
        targetType: body.type,
        allow: body.allow,
        deny: body.deny
      },
      (signedAction) => hachiman.rest.putOverwrite(channelId, targetId, body, { signedAction })
    )
  },

  deleteOverwrite(channelId: string, targetId: string): Promise<void> {
    const guildId = guildOfChannel(channelId)
    const existing = hachiman.cache.channels
      .get(channelId)
      ?.permissionOverwrites.find((o) => o.id === targetId)
    const targetType =
      existing?.type ?? (hachiman.cache.roles.get(guildId)?.has(targetId) ? 'role' : 'member')
    return signed(
      guildId,
      { type: AdminActionType.OVERWRITE_DELETE, channelId, targetId, targetType },
      (signedAction) => hachiman.rest.deleteOverwrite(channelId, targetId, { signedAction })
    )
  },

  /** A roles change is signed (member_roles); a nick change alone is plain REST. */
  updateMember(guildId: string, userId: string, body: UpdateMemberBody) {
    const roles = body.roles
    if (roles === undefined) return hachiman.rest.updateMember(guildId, userId, body)
    return signed(
      guildId,
      { type: AdminActionType.MEMBER_ROLES, userId, roleIds: [...new Set(roles)] },
      (signedAction) => hachiman.rest.updateMember(guildId, userId, body, { signedAction })
    )
  },

  /** A historyVisibility change is signed (§12.6); other fields are plain REST. */
  updateChannel(channelId: string, body: UpdateChannelBody) {
    const historyVisibility = body.historyVisibility
    if (historyVisibility === undefined) return hachiman.rest.updateChannel(channelId, body)
    return signed(
      guildOfChannel(channelId),
      { type: AdminActionType.CHANNEL_HISTORY_VISIBILITY, channelId, historyVisibility },
      (signedAction) => hachiman.rest.updateChannel(channelId, body, { signedAction })
    )
  }
}
