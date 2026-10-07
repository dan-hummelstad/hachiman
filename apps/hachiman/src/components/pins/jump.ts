import type { Channel } from '@hachiman/client'
import { navigate } from '@/stores/navStore'

/** Opens a channel, DM or thread as one navigation. */
export function openChannelView(channel: Channel): void {
  navigate(
    channel.guildId === null
      ? { kind: 'dm', channelId: channel.id }
      : { kind: 'channel', guildId: channel.guildId, channelId: channel.id }
  )
}

/** How long a jump waits for the row to render (the transcript loads after the switch). */
const JUMP_TRIES = 30
const JUMP_STEP_MS = 100

/**
 * Opens the channel of a message and scrolls its row into view with a short accent ring. When
 * the row is not in the loaded history, the channel opens at the present.
 */
export function jumpToMessage(channel: Channel, messageId: string): void {
  openChannelView(channel)
  let tries = 0
  const look = (): void => {
    const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!row) {
      if (++tries < JUMP_TRIES) setTimeout(look, JUMP_STEP_MS)
      return
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.animate(
      [
        { boxShadow: 'inset 0 0 0 2px var(--accent-primary)' },
        { boxShadow: 'inset 0 0 0 2px transparent' }
      ],
      { duration: 1800, easing: 'ease-out' }
    )
  }
  requestAnimationFrame(look)
}
