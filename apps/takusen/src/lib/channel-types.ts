/**
 * Guild channel types that carry encrypted content in an MLS group
 * (docs/gateway-protocol.md §12.6): text messages and pages (§12.20). Each one
 * is in the guild's public_set group, or in its own channel group when its
 * overwrites hide it from @everyone. A `thread` is not in this list: it has no
 * group of its own and uses the group of its parent text channel.
 */
export const TEXT_GROUP_TYPES = ['text', 'pages'] as const

export type TextGroupType = (typeof TEXT_GROUP_TYPES)[number]

export function hasTextGroup(type: string): type is TextGroupType {
  return TEXT_GROUP_TYPES.some((t) => t === type)
}

/** The one channel type that can hold threads (§4 Threads). */
export const THREAD_PARENT_TYPE = 'text'
