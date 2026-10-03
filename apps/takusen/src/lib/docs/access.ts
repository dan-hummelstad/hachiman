/**
 * Access to the page routes (docs/gateway-protocol.md §4 Pages): VIEW_CHANNEL
 * for every route, SEND_MESSAGES for the writes, and a channel of type pages.
 * A page that the caller cannot view is a 404.
 */
import { has, Permissions } from '@hachiman/client/permissions'

import { db } from '@/db/client'
import type { DocPageRow } from '@/db/schema'
import { ApiError, MissingPermissionsError, NotFoundError } from '@/lib/errors'
import { loadChannelAccess, requirePermission, type ChannelAccess } from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { acceptDocEnvelope } from '@/lib/mls/envelopes'

import type { DocsRepo } from './repo'
import { drizzleDocsRepo } from './repo.drizzle'
import type { AcceptDocEnvelope } from './service'

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

function pagesAccess(access: ChannelAccess, mode: PageMode): PagesChannelAccess {
  checkPageAccess(access.channel.type, access.permissions, mode)
  // A pages channel is a guild channel: checkPageAccess rejected the rest.
  return { ...access, guildId: access.channel.guildId! }
}

export async function loadPagesChannel(channelId: string, userId: string, mode: PageMode): Promise<PagesChannelAccess> {
  return pagesAccess(await loadChannelAccess(channelId, userId), mode)
}

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
  return { page, access: pagesAccess(access, mode) }
}

/** Runs a page write in one transaction: the repo and acceptDocEnvelope share its `tx`. */
export function docsTransaction<T>(fn: (repo: DocsRepo, accept: AcceptDocEnvelope) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(drizzleDocsRepo(tx), (input) => acceptDocEnvelope(tx, input)))
}
