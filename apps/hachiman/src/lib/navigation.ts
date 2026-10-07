import type { Channel } from '@hachiman/client'
import { navigate, useNavStore } from '@/stores/navStore'

/** Opens a channel, DM or thread as one navigation. */
export function openChannelView(channel: Pick<Channel, 'id' | 'guildId'>): void {
  navigate(
    channel.guildId === null
      ? { kind: 'dm', channelId: channel.id }
      : { kind: 'channel', guildId: channel.guildId, channelId: channel.id }
  )
}

/**
 * Opens the channel of a message and asks its transcript to show the row (navStore
 * `pendingJump`). When the row is not in the loaded history, the channel opens at the present.
 */
export function jumpToMessage(channel: Pick<Channel, 'id' | 'guildId'>, messageId: string): void {
  openChannelView(channel)
  useNavStore.getState().setPendingJump({ channelId: channel.id, messageId })
}

/** Scrolls a rendered transcript row into view with a short accent ring. False: not rendered. */
export function highlightRow(messageId: string): boolean {
  const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
  if (!row) return false
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.animate(
    [
      { boxShadow: 'inset 0 0 0 2px var(--accent-primary)' },
      { boxShadow: 'inset 0 0 0 2px transparent' }
    ],
    { duration: 1800, easing: 'ease-out' }
  )
  return true
}

/**
 * What a transcript does with a pending jump: 'show' the row when it has it, 'drop' the jump
 * when the history has loaded without it, else 'wait' for the history.
 */
export function jumpStep(
  messageId: string,
  rowIds: readonly string[],
  historyLoaded: boolean
): 'show' | 'drop' | 'wait' {
  if (rowIds.includes(messageId)) return 'show'
  return historyLoaded ? 'drop' : 'wait'
}
