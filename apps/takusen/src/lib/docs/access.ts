/**
 * Access to the page routes (docs/gateway-protocol.md §4 Pages): VIEW_CHANNEL
 * for every route, SEND_MESSAGES for the writes, and a channel of type pages.
 * A page that the caller cannot view is a 404.
 */
import { has, Permissions } from '@hachiman/client/permissions'

import type { DocPageRow } from '@/db/schema'
import { ApiError, MissingPermissionsError, NotFoundError } from '@/lib/errors'
import { loadChannelAccess, requirePermission, type ChannelAccess } from '@/lib/guild-access'
import { assertId } from '@/lib/ids'

import { drizzleDocsRepo } from './repo.drizzle'

export type PageMode = 'read' | 'write'

/** The pure check of every page route, after the channel is loaded. */
export function checkPageAccess(channelType: string, permissions: number, mode: PageMode): void {
  if (!has(permissions, Permissions.VIEW_CHANNEL)) throw new NotFoundError('Unknown page')
  if (channelType !== 'pages') throw new ApiError('NotPagesChannel', 400, 'the channel is not a pages channel')
  if (mode === 'write') requirePermission(permissions, Permissions.SEND_MESSAGES)
}

export interface PagesChannelAccess extends ChannelAccess {
  guildId: string
}

function withGuild(access: ChannelAccess): PagesChannelAccess {
  // A pages channel is a guild channel: checkPageAccess rejected the rest.
  return { ...access, guildId: access.channel.guildId! }
}

/** /channels/:id/pages. */
export async function loadPagesChannel(channelId: string, userId: string, mode: PageMode): Promise<PagesChannelAccess> {
  const access = await loadChannelAccess(channelId, userId)
  checkPageAccess(access.channel.type, access.permissions, mode)
  return withGuild(access)
}

/** /pages/:pageId/... */
export async function loadPage(pageId: string, userId: string, mode: PageMode): Promise<{ page: DocPageRow; access: PagesChannelAccess }> {
  assertId(pageId, 'page')
  const page = await drizzleDocsRepo().getPage(pageId)
  if (!page) throw new NotFoundError('Unknown page')
  let access: ChannelAccess
  try {
    access = await loadChannelAccess(page.channelId, userId)
  } catch (err) {
    if (err instanceof MissingPermissionsError) throw new NotFoundError('Unknown page')
    throw err
  }
  checkPageAccess(access.channel.type, access.permissions, mode)
  return { page, access: withGuild(access) }
}
