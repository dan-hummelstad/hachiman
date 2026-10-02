/**
 * Guild channel types that carry encrypted content in an MLS group
 * (docs/gateway-protocol.md §12.6): text messages and pages (§12.20). Each one
 * is in the guild's public_set group, or in its own channel group when its
 * overwrites hide it from @everyone.
 */
export const TEXT_GROUP_TYPES = ['text', 'pages'] as const

export type TextGroupType = (typeof TEXT_GROUP_TYPES)[number]

export function hasTextGroup(type: string): type is TextGroupType {
  return type === 'text' || type === 'pages'
}
