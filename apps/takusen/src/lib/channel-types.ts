/**
 * Guild channel types that carry encrypted content in an MLS group
 * (docs/gateway-protocol.md §12.6): text messages, and the page docs of the
 * pages, canvas and web channels (§12.20). Each one is in the guild's
 * public_set group, or in its own channel group when its overwrites hide it
 * from @everyone. A `thread` is not in this list: it has no
 * group of its own and uses the group of its parent text channel.
 */
export const TEXT_GROUP_TYPES = ['text', 'pages', 'canvas', 'web'] as const

export type TextGroupType = (typeof TEXT_GROUP_TYPES)[number]

export function hasTextGroup(type: string): type is TextGroupType {
  return TEXT_GROUP_TYPES.some((t) => t === type)
}

/**
 * The channel types that hold a page tree (§4 Pages). A pages channel holds markdown pages, a
 * canvas channel whiteboards, a web channel shared web views: the server sees the same encrypted
 * docs in each.
 */
export const PAGE_CHANNEL_TYPES = ['pages', 'canvas', 'web'] as const

export function hasPageTree(type: string): boolean {
  return PAGE_CHANNEL_TYPES.some((t) => t === type)
}

/** The one channel type that can hold threads (§4 Threads). */
export const THREAD_PARENT_TYPE = 'text'
