import { useMemo } from 'react'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { cn } from '@/lib/utils'
import { selectChannel } from '@/stores/navStore'

const REF = /(^|[^\w#])#([\p{L}\p{N}_-]{1,100})/gu

/**
 * Plain message text with `#name` of a channel of this guild as an accent chip that opens the
 * channel. Text that names no known channel stays plain.
 */
export function TextWithChannelRefs({
  text,
  guildId
}: {
  text: string
  guildId: string | null
}): React.ReactNode {
  const channels = useGuildChannels(guildId)
  const byName = useMemo(
    () => new Map(channels.filter((c) => c.type !== 'category').map((c) => [c.name, c])),
    [channels]
  )
  if (!guildId || !text.includes('#')) return text
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(REF)) {
    const channel = byName.get(m[2])
    if (!channel) continue
    const start = m.index + m[1].length
    if (start > last) out.push(text.slice(last, start))
    out.push(
      <button
        key={start}
        type="button"
        onClick={() => selectChannel(channel.id)}
        className={cn(
          'rounded-check bg-accent-tint text-accent-text inline px-1 font-semibold hover:underline',
          'focus-visible:outline-line-focus outline-none focus-visible:outline-2'
        )}
      >
        #{channel.name}
      </button>
    )
    last = start + 1 + m[2].length
  }
  if (last === 0) return text
  if (last < text.length) out.push(text.slice(last))
  return out
}
