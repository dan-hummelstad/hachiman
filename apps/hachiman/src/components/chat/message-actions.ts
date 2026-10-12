import { useMemo } from 'react'
import {
  Copy,
  Info,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { defaultThreadName } from '@/components/threads/thread-name'
import { parseReactionKey } from '@/lib/custom-emoji'
import { tokenize } from '@/lib/mentions'
import { displayName } from '@/lib/model'
import { stripPageLinks } from '@/lib/page-link-text'
import { messagesService } from '@/services/MessagesService'
import { pinsService } from '@/services/guild-features'
import { useChannelStore } from '@/stores/channelStore'
import { useComposerStore } from '@/stores/composerStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import type { ChatMessage } from '@/stores/messagesStore'
import { usePinned } from '@/stores/pinsStore'
import { useUserStore } from '@/stores/userStore'
import type { RowPolicy } from './row-policy'
import { react } from './transcript-actions'

/**
 * The actions of one transcript row. The desktop hover toolbar, its "More" menu and the mobile
 * action sheet (docs/ios-mobile-ui-spec.md A3) render the same list: each picks the ids it shows.
 */
export type MessageActionId =
  'react' | 'reply' | 'thread' | 'copy' | 'pin' | 'edit' | 'info' | 'delete'

/** One action of a row. `react` takes the reaction key (a Unicode emoji or a custom `name:id`). */
export interface MessageActionOf<I extends MessageActionId> {
  id: I
  label: string
  icon: LucideIcon
  tone: 'default' | 'danger'
  /** `copy` and `delete` resolve when done and reject with an Error whose message is for the user. */
  run: I extends 'react' ? (emoji: string) => void : () => void | Promise<void>
}

export type MessageAction = { [I in MessageActionId]: MessageActionOf<I> }[MessageActionId]

export function findAction<I extends MessageActionId>(
  actions: readonly MessageAction[],
  id: I
): Extract<MessageAction, { id: I }> | undefined {
  return actions.find((a) => a.id === id) as Extract<MessageAction, { id: I }> | undefined
}

/** The actions of a message's "More" menu on desktop, in menu order: pin (N13), thread (N12), info. */
export const MORE_ACTIONS = ['pin', 'thread', 'info'] as const satisfies readonly MessageActionId[]

export const hasMoreItems = (actions: readonly MessageAction[]): boolean =>
  MORE_ACTIONS.some((id) => findAction(actions, id) !== undefined)

/** The short text at the end of the action sheet's pin row ("4 pinned"), or null. */
export const pinHint = (count: number | null): string | null => (count ? `${count} pinned` : null)

/** What decides which actions a row offers. */
export interface ActionFacts {
  policy: RowPolicy
  mine: boolean
  /** The row decrypted. */
  readable: boolean
  /** Still sending (an optimistic row). */
  pending: boolean
  /** The send failed (an optimistic row that never reached the server). */
  failed: boolean
  /** The row has a client_msg_id: reactions and replies point at it. */
  hasTarget: boolean
  /** The text without page links is not empty: "Copy text" has something to copy. */
  hasText: boolean
}

/**
 * The actions a row offers. A row that is still sending offers only Copy; a failed
 * one also Delete (it drops the local row). A deleted pending row would come back with the echo.
 */
export function availableActions(f: ActionFacts): MessageActionId[] {
  const copy = f.readable && f.hasText
  if (f.pending || f.failed) {
    const out: MessageActionId[] = []
    if (copy) out.push('copy')
    if (f.failed) out.push('delete')
    return out
  }
  const answer = f.policy.canSend && f.hasTarget
  const offered: [MessageActionId, boolean][] = [
    ['react', answer && f.readable],
    ['reply', answer],
    ['thread', f.policy.canThread && f.readable],
    ['copy', copy],
    ['pin', f.policy.canPin],
    ['edit', f.mine && f.readable],
    ['info', true],
    ['delete', f.mine || f.policy.canManage]
  ]
  return offered.flatMap(([id, ok]) => (ok ? [id] : []))
}

/** Display names for the wire forms of a text. Null: not known. */
export interface NameLookup {
  user: (userId: string) => string | null
  role: (roleId: string) => string | null
}

/**
 * The text that "Copy text" puts on the clipboard: what the row shows, with the wire forms turned
 * back into display text. `<@id>` becomes `@name` (raw when unknown, as the row shows it),
 * `<@&id>` becomes `@Role` (or `@deleted-role`), `<:name:id>` becomes `:name:`. Page links drop
 * out: the row shows them as cards (components/chat/message-summary.ts does the same).
 */
export function plainMessageText(content: string, names: NameLookup): string {
  return tokenize(stripPageLinks(content))
    .map((t) => {
      switch (t.kind) {
        case 'text':
        case 'link':
          return t.value
        case 'emoji':
          return `:${t.name}:`
        case 'mention': {
          if ('roleId' in t) return `@${names.role(t.roleId) ?? 'deleted-role'}`
          if ('userId' in t) {
            const name = names.user(t.userId)
            return name === null ? t.value : `@${name}`
          }
          return t.value
        }
      }
    })
    .join('')
}

/** The quick reactions of the action sheet when I have no recent picks. */
export const DEFAULT_QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🔥', '🎉', '👀']
export const QUICK_REACTION_COUNT = 6

/**
 * The `count` quick reactions of the action sheet: my recent picks first (prefsStore), topped up
 * with the defaults, without repeats. A custom emoji that `usable` does not know (another
 * device's pick, a deleted emoji) is skipped.
 */
export function quickReactionKeys(
  recent: readonly string[],
  usable: (key: string) => boolean,
  count = QUICK_REACTION_COUNT
): string[] {
  const out: string[] = []
  for (const key of [...recent, ...DEFAULT_QUICK_REACTIONS]) {
    if (out.length === count) break
    if (!out.includes(key) && usable(key)) out.push(key)
  }
  return out
}

/** The room between the lifted row and the top of the action sheet. */
export const LIFT_GAP = 12

export interface LiftPlacement {
  /** The top of the lifted row, in viewport px. */
  top: number
  /** Its height: the row's, or less when it does not fit. */
  height: number
  /** The row is cut to fit: its foot fades out. */
  clamped: boolean
}

/**
 * Where the lifted row of a long press goes (spec A3): `gap` px above the sheet, and no higher
 * than `minTop` (under the status bar). A row taller than the room is cut to it.
 */
export function liftPlacement({
  rowHeight,
  sheetTop,
  minTop,
  gap = LIFT_GAP
}: {
  rowHeight: number
  sheetTop: number
  minTop: number
  gap?: number
}): LiftPlacement {
  const room = Math.max(0, sheetTop - gap - minTop)
  const height = Math.min(rowHeight, room)
  return { top: sheetTop - gap - height, height, clamped: rowHeight > room }
}

/** The display name of a user for copied text, from the stores at the time of the copy. */
function userName(guildId: string | null, userId: string): string | null {
  const member = guildId ? useGuildStore.getState().members.get(guildId)?.get(userId) : undefined
  if (member) return displayName(member)
  const me = useUserStore.getState().me
  if (me?.id === userId) return displayName(undefined, me)
  for (const c of useChannelStore.getState().channels.values()) {
    if (c.guildId !== null) continue
    const u = c.recipients?.find((r) => r.id === userId)
    if (u) return displayName(undefined, u)
  }
  return null
}

const roleName = (guildId: string | null, roleId: string): string | null =>
  (guildId ? useGuildStore.getState().roles.get(guildId)?.get(roleId)?.name : undefined) ?? null

export function copyTextOf(message: Pick<ChatMessage, 'content' | 'guildId'>): string {
  const { guildId } = message
  return plainMessageText(message.content, {
    user: (id) => userName(guildId, id),
    role: (id) => roleName(guildId, id)
  })
}

/** A custom reaction key that this client can show (its guild emoji is known). */
export const usableReactionKey = (key: string, index: ReadonlyMap<string, unknown>): boolean => {
  const custom = parseReactionKey(key)
  return custom === null || index.has(custom.id)
}

/**
 * The actions of `message` (see `availableActions`), with their labels, icons and handlers.
 * `onEdit` starts editing the row.
 */
export function useMessageActions(
  message: ChatMessage,
  policy: RowPolicy,
  onEdit: () => void
): MessageAction[] {
  const pinned = usePinned(message.channelId, message.id)
  const mine = useUserStore((s) => s.me?.id === message.author.id)

  return useMemo(() => {
    const { channelId, clientMsgId: target } = message
    const readable = message.decrypt.status === 'ok'
    const ids = availableActions({
      policy,
      mine,
      readable,
      pending: !!message.pending,
      failed: !!message.failed,
      hasTarget: target !== '',
      hasText: stripPageLinks(message.content) !== ''
    })
    const base = { tone: 'default' } as const
    const make = (id: MessageActionId): MessageAction => {
      switch (id) {
        case 'react':
          return {
            ...base,
            id,
            label: 'Add reaction',
            icon: SmilePlus,
            run: (emoji: string) => react(channelId, target, emoji, false)
          }
        case 'reply':
          return {
            ...base,
            id,
            label: 'Reply',
            icon: Reply,
            run: () => useComposerStore.getState().setReplyTarget(channelId, target)
          }
        case 'thread':
          return {
            ...base,
            id,
            label: 'Create thread',
            icon: MessagesSquare,
            run: () =>
              openDialog({
                kind: 'createThread',
                parentId: channelId,
                startMessageId: message.id,
                name: defaultThreadName(message.content)
              })
          }
        case 'copy':
          return {
            ...base,
            id,
            label: 'Copy text',
            icon: Copy,
            run: () => navigator.clipboard.writeText(copyTextOf(message))
          }
        case 'pin':
          return {
            ...base,
            id,
            label: pinned ? 'Unpin message' : 'Pin message',
            icon: pinned ? PinOff : Pin,
            run: () => {
              const call = pinned ? pinsService.unpin : pinsService.pin
              call(channelId, message.id).catch((e: unknown) =>
                console.warn(`[pins] ${pinned ? 'unpin' : 'pin'} failed`, e)
              )
            }
          }
        case 'edit':
          return { ...base, id, label: 'Edit', icon: Pencil, run: onEdit }
        case 'info':
          return {
            ...base,
            id,
            label: 'Info',
            icon: Info,
            run: () => openDialog({ kind: 'messageInfo', channelId, messageId: message.id })
          }
        case 'delete':
          return {
            ...base,
            id,
            label: 'Delete',
            icon: Trash2,
            tone: 'danger',
            run: () =>
              message.failed
                ? Promise.resolve(messagesService.discard(message))
                : messagesService.delete(channelId, message.id)
          }
      }
    }
    return ids.map(make)
  }, [message, policy, mine, pinned, onEdit])
}
