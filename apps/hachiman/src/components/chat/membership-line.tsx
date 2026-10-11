import { KeyRound, UserPlus } from 'lucide-react'
import type { Channel, Member } from '@hachiman/client'
import type { MembershipEvent } from '@hachiman/crypto'
import { useMemberView } from '@/hooks/use-member'
import { useUserStore } from '@/stores/userStore'

/**
 * One membership change of the channel's MLS group, from a commit that this device processed
 * (§12.16: "A added B"). The names come from the guild cache; the user ids come from the
 * verified leaf credentials.
 */
export function MembershipLine({
  event,
  channel
}: {
  event: MembershipEvent
  channel: Channel
}): React.JSX.Element {
  const subjects = [...new Set(event.subjects.map((s) => s.userId))]
  const devices = event.subjects.length
  const who = (
    <>
      {subjects.map((id, i) => (
        <span key={id}>
          {i > 0 && (i === subjects.length - 1 ? ' and ' : ', ')}
          <UserName channel={channel} userId={id} />
        </span>
      ))}
    </>
  )
  const actor = event.actorUserId ? <UserName channel={channel} userId={event.actorUserId} /> : null
  const what = (() => {
    switch (event.kind) {
      case 'created':
        return <>{actor ?? 'Someone'} started end-to-end encryption here.</>
      case 'added':
        return (
          <>
            {actor ?? 'Someone'} added {who} ({devices} {devices === 1 ? 'device' : 'devices'}).
          </>
        )
      case 'removed':
        return (
          <>
            {actor ?? 'Someone'} removed {who} ({devices} {devices === 1 ? 'device' : 'devices'}).
          </>
        )
      case 'joined_external':
        return <>{who} joined with a new device.</>
      case 'resynced':
        return <>{who} renewed the keys of a device.</>
      case 'invite_with_history':
        return (
          <>
            {actor ?? 'Someone'} made an invite that includes history. A person who has its link can
            read the history here.
          </>
        )
    }
  })()
  return (
    <div
      role="note"
      className="text-text-tertiary flex items-center gap-2 px-5 py-1 text-xs leading-5 font-medium"
    >
      <KeyRound className="size-3.5 shrink-0" aria-hidden />
      <span>{what}</span>
    </div>
  )
}

function UserName({ channel, userId }: { channel: Channel; userId: string }): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const fallback = me?.id === userId ? me : channel.recipients?.find((u) => u.id === userId)
  const { name } = useMemberView(channel.guildId, userId, fallback ?? undefined)
  return <span className="text-text-secondary font-semibold">{name}</span>
}

/** A member joined the guild: shown in the guild's welcome channel (§4 Guilds). */
export function JoinLine({
  member,
  channel
}: {
  member: Member
  channel: Channel
}): React.JSX.Element {
  return (
    <div
      role="note"
      className="text-text-tertiary flex items-center gap-2 px-5 py-1 text-xs leading-5 font-medium"
    >
      <UserPlus className="text-feature-voice size-3.5 shrink-0" aria-hidden />
      <span>
        <UserName channel={channel} userId={member.user.id} /> joined the guild. Say hi!
      </span>
    </div>
  )
}
