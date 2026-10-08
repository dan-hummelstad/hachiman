import { useMemberView } from '@/hooks/use-member'
import { mentionsUser, type MentionToken, type Token } from '@/lib/mentions'
import { hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { TextWithChannelRefs } from './channel-ref'
import { InlineCustomEmoji } from './emoji'

/** The tokens of a message text: text with channel refs, links, mentions and custom emojis (lib/mentions). */
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
        ) : t.kind === 'emoji' ? (
          <InlineCustomEmoji key={i} id={t.id} name={t.name} />
        ) : 'roleId' in t ? (
          <RoleMention key={i} roleId={t.roleId} raw={t.value} guildId={guildId} />
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

/**
 * `<@&roleId>` as `@Role` in the role colour, highlighted when I hold the role. A role that is not
 * known (deleted, or another guild) shows as "@deleted-role".
 */
function RoleMention({
  roleId,
  raw,
  guildId
}: {
  roleId: string
  raw: string
  guildId: string | null
}): React.JSX.Element {
  const role = useGuildStore((s) => (guildId ? s.roles.get(guildId)?.get(roleId) : undefined))
  const meId = useUserStore((s) => s.me?.id)
  const mine = useGuildStore(
    (s) =>
      !!guildId && !!meId && (s.members.get(guildId)?.get(meId)?.roles.includes(roleId) ?? false)
  )
  const color = role && role.color !== 0 ? hexColor(role.color) : undefined
  return (
    <span
      title={role ? undefined : raw}
      className={cn(
        'rounded-check px-1 font-semibold',
        mine ? 'bg-feature-event/20 text-feature-event-text' : 'bg-accent-tint text-accent-text'
      )}
      style={!mine && color ? { color } : undefined}
    >
      @{role?.name ?? 'deleted-role'}
    </span>
  )
}
