import type { Channel } from '@hachiman/client'
import { displayName } from '@/lib/model'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore } from '@/stores/messagesStore'

const EMPTY_TYPING: Map<string, number> = new Map()

/** "alice is typing…" under the composer. Always reserves its line so the layout never jumps. */
export function TypingLine({ channel }: { channel: Channel }): React.JSX.Element {
  const typing = useMessageStore((s) => s.typing.get(channel.id) ?? EMPTY_TYPING)
  const members = useGuildStore((s) =>
    channel.guildId ? s.members.get(channel.guildId) : undefined
  )
  const names = [...typing.keys()].map((id) =>
    displayName(
      members?.get(id),
      channel.recipients?.find((u) => u.id === id)
    )
  )
  return (
    <div
      className="text-text-tertiary flex h-6 items-center gap-1.5 truncate px-1 text-xs leading-6 font-medium"
      aria-live="polite"
    >
      {names.length > 0 && (
        <>
          <span aria-hidden className="flex shrink-0 gap-0.5">
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                className="bg-text-tertiary size-1 animate-pulse rounded-full"
                style={{ animationDelay: `${d}ms` }}
              />
            ))}
          </span>
          <span className="truncate">
            <TypingText names={names} />
          </span>
        </>
      )}
    </div>
  )
}

function TypingText({ names }: { names: string[] }): React.JSX.Element {
  const b = (n: string): React.JSX.Element => (
    <span key={n} className="text-text-primary font-bold">
      {n}
    </span>
  )
  if (names.length > 3) return <>Several people are typing…</>
  if (names.length === 1) return <>{b(names[0])} is typing…</>
  const head = names.slice(0, -1)
  return (
    <>
      {head.map((n, i) => (
        <span key={n}>
          {i > 0 && ', '}
          {b(n)}
        </span>
      ))}{' '}
      and {b(names[names.length - 1])} are typing…
    </>
  )
}
