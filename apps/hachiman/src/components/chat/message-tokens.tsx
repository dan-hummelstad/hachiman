import { useMemberView } from '@/hooks/use-member'
import { mentionsUser, type MentionToken, type Token } from '@/lib/mentions'
import { cn } from '@/lib/utils'
import { useUserStore } from '@/stores/userStore'
import { TextWithChannelRefs } from './channel-ref'

/** The tokens of a message text: text with channel refs, links and mentions (lib/mentions). */
export function MessageTokens({
  tokens,
  guildId
}: {
  tokens: readonly Token[]
  guildId: string | null
}): React.JSX.Element {
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          <TextWithChannelRefs key={i} text={t.value} guildId={guildId} />
        ) : t.kind === 'link' ? (
          <a
            key={i}
            href={t.value}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-text underline-offset-2 hover:underline"
          >
            {t.value}
          </a>
        ) : (
          <Mention key={i} token={t} guildId={guildId} />
        )
      )}
    </>
  )
}

/** `@name`, highlighted when it's me. `<@id>` renders as the member's display name when known. */
function Mention({
  token,
  guildId
}: {
  token: MentionToken
  guildId: string | null
}): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const byId = 'userId' in token
  const fallback = byId && me?.id === token.userId ? me : undefined
  const { member, name } = useMemberView(guildId, byId ? token.userId : '', fallback)
  const isMe = !!me && mentionsUser(token, me)
  return (
    <span
      className={cn(
        'rounded-check px-1 font-semibold',
        isMe ? 'bg-feature-event/20 text-feature-event-text' : 'bg-accent-tint text-accent-text'
      )}
    >
      {byId && (member || fallback) ? `@${name}` : token.value}
    </span>
  )
}
