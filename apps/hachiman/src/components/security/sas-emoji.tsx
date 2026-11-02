import type { SasEmoji } from '@hachiman/crypto'
import { cn } from '@/lib/utils'

/**
 * The 7 SAS emoji with their names (§12.5), in order. The code is content, not a signal: no hue.
 * Desktop: seven tiles in a row. `size="touch"` is the phone form: tiles of 76 in rows of 4 and 3
 * (the second row centred).
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
        'grid',
        touch ? 'grid-cols-8 gap-x-[7px] gap-y-[7px]' : 'grid-cols-4 gap-1.5 sm:grid-cols-7'
      )}
    >
      {emoji.map((e, i) => (
        <li
          key={i}
          className={cn(
            'border-line-hairline bg-surface-sunken flex flex-col items-center justify-center gap-1 border text-center',
            touch
              ? 'border-line-strong col-span-2 h-[76px] rounded-[12px] [&:nth-child(5)]:col-start-2'
              : 'rounded-control h-[62px]'
          )}
        >
          <span aria-hidden className={touch ? 'text-[30px] leading-9' : 'text-[25px] leading-7'}>
            {e.emoji}
          </span>
          <span
            className={cn(
              'max-w-full truncate px-0.5 font-mono uppercase',
              touch
                ? 'text-text-secondary text-[9px] tracking-[0.5px]'
                : 'text-text-tertiary text-[8px] tracking-[0.4px]'
            )}
          >
            {e.name}
          </span>
        </li>
      ))}
    </ol>
  )
}
