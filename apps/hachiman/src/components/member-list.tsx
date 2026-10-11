import { useMemo, useState } from 'react'
import { AudioLines, Crown, Volume2 } from 'lucide-react'
import type { Member, PresenceStatus } from '@hachiman/client'
import { memberDetail, type MemberDetail } from '@/components/chat/mobile-mention-model'
import { MemberSheet } from '@/components/mobile/member-sheet'
import { CustomStatusLine } from '@/components/people/custom-status-line'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { VoiceActivityLine } from '@/components/people/voice-activity-line'
import { UserAvatar } from '@/components/shell/user-avatar'
import { PRESENCE_LABEL } from '@/components/ui/presence'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SystemTag } from '@/components/ui/system-tag'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { LiveCard } from '@/components/voice/live-card'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
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
 *
 * Mobile layout (the members drawer, docs/ios-mobile-ui-spec.md A4): the M4 sizes, a 40 px fade
 * at the foot of the list above the live cards, and a presence line ("Idle", "Do not disturb")
 * for a member with no voice activity and no custom status. A tap opens the profile sheet; a hold
 * opens the member sheet (`components/mobile/member-sheet.tsx`). One sheet serves the list.
 */
export function MemberList({ guildId }: { guildId: string }): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  // The member whose sheet shows. The user id stays after the sheet closes, so that the sheet can
  // slide out and a kick or ban confirm that it opened stays up.
  const [held, setHeld] = useState<{ userId: string; open: boolean } | null>(null)
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
        <div className="mobile:gap-0 mobile:pt-1.5 mobile:pb-10 flex flex-col gap-3 px-2 py-3">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.label}>
              <h3 className="section-label mobile:gap-[7px] mobile:pt-2.5 mobile:pb-0.5 mobile:tracking-[0.6px] flex items-center gap-1.5 px-2 pb-1">
                {(g.color || mobile) && (
                  // Mobile (M4): the offline group gets a grey mark too.
                  <span
                    className="size-2 shrink-0"
                    style={{
                      backgroundColor: g.color ? roleInk(g.color) : 'var(--text-disabled)'
                    }}
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
                    mobile={mobile}
                    onHold={mobile ? (userId) => setHeld({ userId, open: true }) : undefined}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ScrollArea>
      {mobile && (
        // The rows run out under it. Zero high, so the live cards keep their place below.
        <div aria-hidden className="relative z-10 shrink-0">
          <div className="from-surface-panel/0 to-surface-panel/95 pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-b" />
        </div>
      )}
      {mobile && held && (
        <MemberSheet
          key={held.userId}
          guildId={guildId}
          userId={held.userId}
          open={held.open}
          onOpenChange={(open) => setHeld({ userId: held.userId, open })}
        />
      )}
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

/**
 * The voice line of the mobile member row (M4), as in the mention list (M6): "Speaking in
 * Lounge", "In Lounge", or "Idle · in Lounge" in the quiet ink while away.
 */
const DETAIL_TONE: Record<MemberDetail['tone'], string> = {
  voice: 'text-feature-voice-text font-bold',
  quiet: 'text-text-tertiary font-medium',
  danger: 'text-feature-danger-text font-bold'
}

/**
 * The presence line of the mobile member row: idle and do not disturb, the states that the dot
 * alone does not spell out. Do not disturb is in the danger ink.
 */
const PRESENCE_LINE: Partial<Record<PresenceStatus, string>> = {
  idle: DETAIL_TONE.quiet,
  dnd: DETAIL_TONE.danger
}

function MobileVoiceLine({ detail }: { detail: MemberDetail }): React.JSX.Element {
  const Icon = detail.icon === 'speaking' ? AudioLines : Volume2
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1 text-xs leading-4', DETAIL_TONE[detail.tone])}
    >
      {detail.icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
      <span className="truncate">{detail.text}</span>
    </span>
  )
}

function MemberRow({
  member,
  guildId,
  dim,
  owner,
  me,
  mobile,
  onHold
}: {
  member: Member
  guildId: string
  dim: boolean
  owner: boolean
  me: boolean
  /** Mobile layout: the presence line, and the M4 voice line in place of VoiceActivityLine. */
  mobile: boolean
  /** A hold on the row opens the member sheet. */
  onHold?: (userId: string) => void
}): React.JSX.Element {
  const userId = member.user.id
  const { name, ink, speaking } = useSpeakingMember(guildId, userId)
  const status = usePresence(userId)
  const activity = useVoiceActivity(userId, guildId)
  const customStatus = useCustomStatus(userId)
  const press = useLongPress(() => onHold?.(userId), { enabled: onHold !== undefined })
  const presenceLine =
    mobile && !dim && !activity && !customStatus?.text ? PRESENCE_LINE[status] : undefined
  const voiceDetail = mobile && activity ? memberDetail(activity, status, null) : null
  return (
    <li>
      <UserProfilePopover userId={userId} guildId={guildId}>
        <button
          type="button"
          {...(onHold ? press : {})}
          className={cn(
            'group rounded-control hover:bg-surface-hover flex min-h-[42px] w-full items-center gap-2.5 px-2 py-1 text-left',
            'mobile:rounded-[7px] mobile:py-[3px] mobile:active:bg-surface-hover',
            'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
            LONG_PRESS_TARGET,
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
                className="text-text-primary mobile:text-[14.5px] mobile:font-bold truncate text-sm leading-5 font-semibold"
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
            {voiceDetail && !dim && <MobileVoiceLine detail={voiceDetail} />}
            {activity && !voiceDetail && !dim && (
              <VoiceActivityLine
                activity={activity}
                className="text-feature-voice-text mobile:font-bold text-xs leading-4 font-semibold"
              />
            )}
            {!activity && !dim && (
              <CustomStatusLine
                userId={userId}
                className="mobile:text-text-tertiary mobile:font-medium"
              />
            )}
            {presenceLine && (
              <span className={cn('truncate text-xs leading-4', presenceLine)}>
                {PRESENCE_LABEL[status]}
              </span>
            )}
          </span>
          {activity?.streaming && !dim && <SystemTag kind="live" />}
        </button>
      </UserProfilePopover>
    </li>
  )
}

/**
 * A member who streams. The frame shows only inside that call (SFrame keys are in the call's MLS
 * group, decision 4), and only while the viewer watches the share. Elsewhere the card shows the streamer's avatar on the live tint.
 */
function StreamerCard({
  guildId,
  userId,
  channelId
}: Streamer & { guildId: string }): React.JSX.Element {
  const channelName = useChannelStore((s) => s.channels.get(channelId)?.name ?? 'voice')
  const inCall = useChannelOccupants(guildId, channelId).length
  const stream = useVoiceStore((s) =>
    s.channelId === channelId && s.watching.has(userId) ? s.screens.get(userId) : undefined
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
