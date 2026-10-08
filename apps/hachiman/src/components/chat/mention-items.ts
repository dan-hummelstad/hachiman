import { useMemo } from 'react'
import type { Channel, Member, Role, User } from '@hachiman/client'
import { pageHref } from '@/components/docs/page-links'
import { useEmojiData } from '@/hooks/use-emoji-data'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { emojiInsert, searchCustomEmoji, type EmojiPick } from '@/lib/custom-emoji'
import { searchEmoji, withSkin } from '@/lib/emoji-data'
import { rankItems, type Trigger } from '@/lib/mention-complete'
import { pageTitle } from '@/services/docs/page-tree'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'

export type MentionItem =
  | { kind: 'user'; id: string; user: User; nick: string | null }
  | { kind: 'role'; id: string; role: Role }
  | { kind: 'everyone'; id: 'everyone' }
  | { kind: 'channel'; id: string; channel: Channel }
  | { kind: 'page'; id: string; page: PageNode; channelName: string }
  /** A Unicode emoji (`id` is the emoji in the chosen skin tone) and its main shortcode. */
  | { kind: 'emoji'; id: string; code: string; pick: EmojiPick }
  | { kind: 'custom-emoji'; id: string; pick: Extract<EmojiPick, { kind: 'custom' }> }

/** What a picked item puts into the text, and for a role or custom emoji its wire form for the send. */
export function insertFor(item: MentionItem): { insert: string; wire?: string } {
  switch (item.kind) {
    case 'user':
      return { insert: `@${item.user.username}` }
    case 'role':
      return { insert: `@${item.role.name}`, wire: `<@&${item.id}>` }
    case 'everyone':
      return { insert: '@everyone' }
    case 'channel':
      return { insert: `#${item.channel.name ?? ''}` }
    case 'page':
      // A page link in a message shows as the page card (page-cards.tsx).
      return { insert: `[${pageTitle(item.page)}](${pageHref(item.id)})` }
    case 'emoji':
    case 'custom-emoji':
      return emojiInsert(item.pick)
  }
}

const NO_MEMBERS: ReadonlyMap<string, Member> = new Map()
const NO_ROLES: ReadonlyMap<string, Role> = new Map()
const NO_ITEMS: MentionItem[] = []
const COMPLETABLE: ReadonlySet<Channel['type']> = new Set(['text', 'voice', 'pages'])

/**
 * The suggestions for `trigger` in `channel`. `@`: the members (a DM: the recipients and me), then
 * the roles and @everyone of the guild (a bare "@": five members, then those). `#`: the guild's
 * channels, then the pages of its pages channels that are loaded. Best match first, at most 10 for `@` and 8 for `#`.
 */
export function useMentionItems(channel: Channel, trigger: Trigger | null): MentionItem[] {
  const guildId = channel.guildId
  const members = useGuildStore((s) => (guildId ? s.members.get(guildId) : undefined) ?? NO_MEMBERS)
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined) ?? NO_ROLES)
  const me = useUserStore((s) => s.me)
  const channels = useGuildChannels(guildId)
  const pagesByChannel = useDocsStore((s) => s.pagesByChannel)
  const guildEmojis = useGuildStore((s) => s.emojis)
  const skinTone = usePrefsStore((s) => s.skinTone)
  const emojiData = useEmojiData(trigger?.char === ':')

  return useMemo(() => {
    if (!trigger) return NO_ITEMS
    const { char, query } = trigger
    if (char === ':') {
      const custom = searchCustomEmoji(guildEmojis, guildId, query, 5).map((e): MentionItem => ({
        kind: 'custom-emoji',
        id: e.id,
        pick: { kind: 'custom', emoji: e }
      }))
      const unicode = emojiData
        ? searchEmoji(emojiData, query.toLowerCase(), 10 - custom.length).map((e): MentionItem => {
            const emoji = withSkin(e, skinTone)
            return {
              kind: 'emoji',
              id: emoji,
              code: e.shortcodes[0] ?? e.label,
              pick: { kind: 'unicode', emoji }
            }
          })
        : []
      return [...custom, ...unicode]
    }
    if (char === '@') {
      const users: MentionItem[] = guildId
        ? [...members.values()].map((m) => ({
            kind: 'user',
            id: m.user.id,
            user: m.user,
            nick: m.nick
          }))
        : [...(channel.recipients ?? []), ...(me ? [me] : [])].map((u) => ({
            kind: 'user',
            id: u.id,
            user: u,
            nick: null
          }))
      const groups: MentionItem[] = guildId
        ? [
            ...[...roles.values()]
              .filter((r) => r.id !== guildId)
              .sort((a, b) => b.position - a.position)
              .map((r): MentionItem => ({ kind: 'role', id: r.id, role: r })),
            { kind: 'everyone', id: 'everyone' }
          ]
        : []
      // A bare "@" shows a few members, then the roles and @everyone, so they are not cut off.
      const pool = query ? [...users, ...groups] : [...users.slice(0, 5), ...groups]
      return rankItems(
        pool,
        query,
        (i) =>
          i.kind === 'user'
            ? [i.user.username, i.nick]
            : i.kind === 'role'
              ? [i.role.name]
              : ['everyone'],
        10
      )
    }
    if (!guildId) return NO_ITEMS
    const chans: MentionItem[] = channels
      .filter((c) => COMPLETABLE.has(c.type) && c.name)
      .map((c) => ({ kind: 'channel', id: c.id, channel: c }))
    const pages: MentionItem[] = channels
      .filter((c) => c.type === 'pages')
      .flatMap((c) =>
        (pagesByChannel.get(c.id) ?? []).map((p): MentionItem => ({
          kind: 'page',
          id: p.id,
          page: p,
          channelName: c.name ?? ''
        }))
      )
    return rankItems([...chans, ...pages], query, (i) =>
      i.kind === 'channel' ? [i.channel.name] : i.kind === 'page' ? [pageTitle(i.page)] : []
    )
  }, [
    trigger,
    guildId,
    members,
    roles,
    me,
    channel.recipients,
    channels,
    pagesByChannel,
    guildEmojis,
    skinTone,
    emojiData
  ])
}
