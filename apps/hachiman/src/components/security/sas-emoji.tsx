import type { SasEmoji } from '@hachiman/crypto'

/** The 7 SAS emoji with their names (§12.5), in order. */
export function SasEmojiRow({ emoji }: { emoji: SasEmoji[] }): React.JSX.Element {
  return (
    <ol
      aria-label="Security emoji"
      className="bg-card grid grid-cols-4 gap-2 border p-3 sm:grid-cols-7"
    >
      {emoji.map((e, i) => (
        <li key={i} className="flex flex-col items-center gap-1 text-center">
          <span aria-hidden className="text-3xl leading-9">
            {e.emoji}
          </span>
          <span className="text-muted-foreground text-[11px] leading-3">{e.name}</span>
        </li>
      ))}
    </ol>
  )
}
