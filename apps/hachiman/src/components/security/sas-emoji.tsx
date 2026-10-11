import type { SasEmoji } from '@hachiman/crypto'
import { cn } from '@/lib/utils'

/**
 * The 7 SAS emoji with their names (§12.5), in order. `size="touch"` is the phone form: glyph 38,
 * name 13/700, in rows of 4 (4 + 3, the second row centred).
 */
export function SasEmojiRow({
  emoji,
  size = 'default'
}: {
  emoji: SasEmoji[]
  size?: 'default' | 'touch'
}): React.JSX.Element {
  const touch = size === 'touch'
  return (
    <ol
      aria-label="Security emoji"
      className={cn(
        'border-line-hairline bg-surface-sunken grid border',
        touch ? 'grid-cols-8 gap-x-2 gap-y-4 px-3 py-4' : 'grid-cols-4 gap-2 p-3 sm:grid-cols-7'
      )}
    >
      {emoji.map((e, i) => (
        <li
          key={i}
          className={cn(
            'flex flex-col items-center gap-1 text-center',
            touch && 'col-span-2 gap-1.5 [&:nth-child(5)]:col-start-2'
          )}
        >
          <span aria-hidden className={touch ? 'text-[38px] leading-[44px]' : 'text-3xl leading-9'}>
            {e.emoji}
          </span>
          <span
            className={
              touch
                ? 'text-text-secondary text-[13px] leading-4 font-bold'
                : 'text-text-tertiary text-[11px] leading-3'
            }
          >
            {e.name}
          </span>
        </li>
      ))}
    </ol>
  )
}
