import type { GuildEmoji } from '@hachiman/client'
import { parseReactionKey } from '@/lib/custom-emoji'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { useGuildStore } from '@/stores/guildStore'

/** The image of a custom emoji (a plaintext upload, like a guild icon). */
export function CustomEmojiImage({
  emoji,
  className
}: {
  emoji: Pick<GuildEmoji, 'name' | 'key'>
  className?: string
}): React.JSX.Element {
  return (
    <img
      src={hachiman.rest.fileUrl(emoji.key)}
      alt={`:${emoji.name}:`}
      title={`:${emoji.name}:`}
      draggable={false}
      loading="lazy"
      className={cn('inline-block size-[1.375em] object-contain align-[-0.3em]', className)}
    />
  )
}

/** `<:name:id>` in a message: the image of a known emoji, else the text `:name:`. */
export function InlineCustomEmoji({ id, name }: { id: string; name: string }): React.JSX.Element {
  const emoji = useGuildStore((s) => s.emojiIndex.get(id))
  return emoji ? <CustomEmojiImage emoji={emoji} /> : <>{`:${name}:`}</>
}

/** A reaction key: a Unicode emoji, or a custom `name:id` as its image (else `:name:`). */
export function ReactionEmoji({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  const custom = parseReactionKey(value)
  const emoji = useGuildStore((s) => (custom ? s.emojiIndex.get(custom.id) : undefined))
  if (!custom) return <span className={className}>{value}</span>
  if (emoji) return <CustomEmojiImage emoji={emoji} className={cn('size-[1.2em]', className)} />
  return <span className={cn('text-[12px]', className)}>{`:${custom.name}:`}</span>
}

/** The plain name of a reaction key, for labels: the emoji itself or `:name:`. */
export function reactionLabel(value: string): string {
  const custom = parseReactionKey(value)
  return custom ? `:${custom.name}:` : value
}
