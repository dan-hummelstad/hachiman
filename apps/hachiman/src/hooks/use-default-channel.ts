import { useEffect } from 'react'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { autoSelect } from '@/lib/auto-select'
import { selectChannel } from '@/stores/navStore'

/**
 * Selects the first text channel of `guildId` when the guild has no (valid) selection
 * (`hasChannel` false). Both shells mount it. The pick is marked as automatic (`autoSelect`), so
 * the mobile sidebar drawer stays open on it.
 */
export function useDefaultChannel(guildId: string | null, hasChannel: boolean): void {
  const guildChannels = useGuildChannels(guildId)
  useEffect(() => {
    if (!guildId || hasChannel) return
    const first = guildChannels.find((c) => c.type === 'text')
    if (first) autoSelect(() => selectChannel(first.id, guildId))
  }, [guildId, hasChannel, guildChannels])
}
