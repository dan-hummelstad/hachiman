import { useMemo } from 'react'
import { Crown } from 'lucide-react'
import type { Member } from '@hachiman/client'
import { CustomStatusLine } from '@/components/people/custom-status-line'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { VoiceActivityLine } from '@/components/people/voice-activity-line'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SystemTag } from '@/components/ui/system-tag'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { LiveCard } from '@/components/voice/live-card'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { usePresence, useSpeakingMember } from '@/hooks/use-member'
import { groupMembers } from '@/lib/member-groups'
import { ROLE_INK_SCOPE, roleInk } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { openChannel } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const EMPTY_STREAMERS: Streamer[] = []

interface Streamer {
  userId: string
  channelId: string
}

/**
 * The members of a guild, for the right column (RightColumn puts the column head above it).
 * Sections from `groupMembers`, names in their highest role colour, an activity line from the
 * voice states, and a live card per member who streams.
 */
export function MemberList({ guildId }: { guildId: string }): React.JSX.Element {
  const members = useGuildStore((s) => s.members.get(guildId))
  const presences = useGuildStore((s) => s.presences)
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const ownerId = useGuildStore((s) => s.guilds.get(guildId)?.ownerId)
  const myId = useUserStore((s) => s.me?.id)
  const groups = useMemo(
    () => groupMembers(members?.values() ?? [], presences, roles),
    [members, presences, roles]
  )
  const states = useVoiceStore((s) => s.voiceStates.get(guildId))
  const streamers = useMemo(() => {
    const list: Streamer[] = []
    for (const vs of states?.values() ?? [])
      if (vs.selfStream && vs.channelId) list.push({ userId: vs.userId, channelId: vs.channelId })
    return list.length > 0 ? list : EMPTY_STREAMERS
  }, [states])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', ROLE_INK_SCOPE)}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-2 py-3">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.label}>
              <h3 className="section-label flex items-center gap-1.5 px-2 pb-1">
                {g.color && (
                  <span
                    className="size-2 shrink-0"
                    style={{ backgroundColor: roleInk(g.color) }}
                    aria-hidden
                  />
                )}
                {g.label} — {g.members.length}
              </h3>
              <ul className="flex flex-col gap-px">
                {g.members.map((m) => (
                  <MemberRow
                    key={m.user.id}
                    member={m}
                    guildId={guildId}
                    dim={g.dim}
                    owner={m.user.id === ownerId}
                    me={m.user.id === myId}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ScrollArea>
      {streamers.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 p-2">
          {streamers.map((s) => (
            <StreamerCard key={s.userId} guildId={guildId} {...s} />
          ))}
        </div>
      )}
    </div>
  )
}

function MemberRow({
  member,
  guildId,
  dim,
  owner,
  me
}: {
  member: Member
  guildId: string
  dim: boolean
  owner: boolean
  me: boolean
}): React.JSX.Element {
  const userId = member.user.id
  const { name, ink, speaking } = useSpeakingMember(guildId, userId)
  const status = usePresence(userId)
  const activity = useVoiceActivity(userId, guildId)
  return (
    <li>
      <UserProfilePopover userId={userId} guildId={guildId}>
        <button
          type="button"
          className={cn(
            'group rounded-control hover:bg-surface-hover flex min-h-[42px] w-full items-center gap-2.5 px-2 py-1 text-left',
            'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
            dim && 'opacity-45 hover:opacity-100'
          )}
        >
          <UserAvatar
            avatar={member.user.avatar}
            name={name}
            color={ink}
            speaking={speaking}
            status={dim ? undefined : status}
            cutout="bg-surface-panel"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="text-text-primary truncate text-sm leading-5 font-semibold"
                style={ink ? { color: ink } : undefined}
              >
                {name}
              </span>
              {owner && (
                <Crown
                  className="text-feature-event-text size-3.5 shrink-0"
                  aria-label="Guild owner"
                />
              )}
              {me && <SystemTag kind="you" />}
            </span>
            {activity && !dim && (
              <VoiceActivityLine
                activity={activity}
                className="text-feature-voice-text text-xs leading-4 font-semibold"
              />
            )}
            {!activity && !dim && <CustomStatusLine userId={userId} />}
          </span>
          {activity?.streaming && !dim && <SystemTag kind="live" />}
        </button>
      </UserProfilePopover>
    </li>
  )
}

/**
 * A member who streams. The frame shows only inside that call: SFrame keys are in the call's MLS
 * group (decision 4). Elsewhere the card shows the streamer's avatar on the live tint.
 */
function StreamerCard({
  guildId,
  userId,
  channelId
}: Streamer & { guildId: string }): React.JSX.Element {
  const channelName = useChannelStore((s) => s.channels.get(channelId)?.name ?? 'voice')
  const inCall = useChannelOccupants(guildId, channelId).length
  const stream = useVoiceStore((s) =>
    s.channelId === channelId ? s.screens.get(userId) : undefined
  )
  return (
    <LiveCard
      guildId={guildId}
      userId={userId}
      channelName={channelName}
      watching={Math.max(0, inCall - 1)}
      size="sm"
      stream={stream}
      onClick={() => openChannel(guildId, channelId)}
    />
  )
}
