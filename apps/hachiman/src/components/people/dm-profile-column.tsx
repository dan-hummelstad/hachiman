import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  AudioLines,
  Crown,
  MonitorSmartphone,
  Phone,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Volume2
} from 'lucide-react'
import type { ContactDevice } from '@hachiman/crypto'
import type { Guild, Role, User } from '@hachiman/client'
import { useNow, useVoiceActivity } from '@/components/people/use-voice-activity'
import {
  TRUST_LOOK,
  useContactSecurity,
  type ContactSecurity
} from '@/components/people/use-contact-security'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { GuildTile } from '@/components/ui/guild-tile'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAction } from '@/hooks/use-action'
import { usePresence } from '@/hooks/use-member'
import { formatElapsed, type VoiceActivity } from '@/lib/member-activity'
import { displayName, hexColor, memberRoles } from '@/lib/model'
import { ROLE_INK_SCOPE, roleInk } from '@/lib/role-ink'
import { userBanner } from '@/lib/user-tint'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { openChannel, selectGuild } from '@/stores/navStore'

/** The guilds that the viewer shares with `userId` (the viewer has members only of its guilds). */
function useMutualGuilds(userId: string): Guild[] {
  const { guilds, members } = useGuildStore(
    useShallow((s) => ({ guilds: s.guilds, members: s.members }))
  )
  return useMemo(
    () =>
      [...guilds.values()]
        .filter((g) => members.get(g.id)?.has(userId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [guilds, members, userId]
  )
}

/** The highest role of the user in the first mutual guild (by name) where it has a role. */
function useStanding(
  userId: string,
  mutual: Guild[]
): { role: Role; guild: Guild; ink: string | undefined } | null {
  const { members, roles } = useGuildStore(
    useShallow((s) => ({ members: s.members, roles: s.roles }))
  )
  return useMemo(() => {
    for (const guild of mutual) {
      const top = memberRoles(members.get(guild.id)?.get(userId), roles.get(guild.id))[0]
      if (top)
        return { role: top, guild, ink: top.color ? roleInk(hexColor(top.color)) : undefined }
    }
    return null
  }, [mutual, members, roles, userId])
}

/**
 * The right column of a DM (E2, E3): banner, avatar, name (crown when the user owns a shared
 * guild), the top role in a shared guild, the voice activity with Join, the security key card,
 * the devices from their certificates and the mutual guilds. Trust is per user (decision 5).
 */
export function DmProfileColumn({ user }: { user: User }): React.JSX.Element {
  const userId = user.id
  const status = usePresence(userId)
  const mutual = useMutualGuilds(userId)
  const standing = useStanding(userId, mutual)
  const owner = mutual.some((g) => g.ownerId === userId)
  const activity = useVoiceActivity(userId, null)
  const security = useContactSecurity(userId)
  const name = displayName(undefined, user)

  return (
    <aside
      aria-label={`Profile of ${name}`}
      className={cn(
        'bg-surface-panel border-line-hairline flex h-full min-h-0 w-[252px] shrink-0 flex-col border-l',
        ROLE_INK_SCOPE
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="h-24" style={{ background: userBanner(userId) }} aria-hidden />
        <div className="flex flex-col gap-4 px-4 pb-5">
          <div className="-mt-11 w-fit">
            <UserAvatar
              avatar={user.avatar}
              name={name}
              size={80}
              status={status}
              cutout="bg-surface-panel"
              className="ring-surface-panel rounded-full ring-4"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-text-primary flex min-w-0 items-center gap-1.5 text-xl leading-7 font-extrabold">
              <span className="truncate">{name}</span>
              {owner && (
                <Crown
                  className="text-feature-event-text size-4 shrink-0"
                  aria-label="Owns a shared guild"
                />
              )}
            </h2>
            {standing && (
              <p
                className="text-accent-text truncate text-[13px] font-semibold"
                style={standing.ink ? { color: standing.ink } : undefined}
              >
                {standing.role.name} in {standing.guild.name}
              </p>
            )}
          </div>

          {activity && <ActivityCard activity={activity} />}

          <SecurityCard name={name} userId={userId} security={security} />

          {security.devices && security.devices.length > 0 && (
            <Devices devices={security.devices} verified={security.trust?.state === 'verified'} />
          )}

          {mutual.length > 0 && (
            <section className="flex flex-col gap-1">
              <h3 className="section-label">Mutual guilds · {mutual.length}</h3>
              <ul className="flex flex-col">
                {mutual.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => selectGuild(g.id)}
                      className="rounded-control hover:bg-surface-hover focus-visible:outline-line-focus -mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 px-2 py-1.5 text-left focus-visible:outline-2"
                    >
                      <GuildTile guild={g} className="size-8 text-xs" />
                      <span className="text-text-primary truncate text-sm font-semibold">
                        {g.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}

function ActivityCard({ activity }: { activity: VoiceActivity }): React.JSX.Element {
  const now = useNow(activity.joinedAt !== null)
  const channel = useChannelStore((s) => s.channels.get(activity.channelId))
  const { run, busy } = useAction()
  const since = activity.joinedAt ? Date.parse(activity.joinedAt) : NaN
  const timer = Number.isNaN(since) ? null : formatElapsed(now - since)
  // A DM has no guild context, so otherGuildName names the guild of the call.
  const detail = [activity.withMe ? 'In the call with you' : activity.otherGuildName, timer]
  const join = (): void => {
    if (!channel) return
    void run('join the call', async () => {
      await voiceService.join(channel)
      openChannel(activity.guildId, activity.channelId)
    })
  }
  return (
    <div className="border-feature-voice/40 bg-feature-voice/10 flex flex-col gap-2.5 border p-3">
      <div className="flex items-start gap-2.5">
        {activity.speaking ? (
          <AudioLines className="text-feature-voice-text mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <Volume2 className="text-feature-voice-text mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="text-text-primary truncate text-[13px] font-bold">
            {activity.speaking ? 'Speaking in' : 'In'} {activity.channelName}
          </span>
          {detail.some(Boolean) && (
            <span className="text-feature-voice-text truncate text-xs tabular-nums">
              {detail.filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      </div>
      {!activity.withMe && channel && (
        <Button variant="voice" size="sm" disabled={busy} onClick={join}>
          <Phone /> Join
        </Button>
      )}
    </div>
  )
}

const TRUST_ICON = {
  verified: ShieldCheck,
  tofu: ShieldQuestion,
  changed: ShieldAlert,
  unknown: ShieldQuestion
} as const

function SecurityCard({
  name,
  userId,
  security
}: {
  name: string
  userId: string
  security: ContactSecurity
}): React.JSX.Element {
  const { trust, safety, error } = security
  const look = trust ? TRUST_LOOK[trust.state] : null
  const Icon = trust ? TRUST_ICON[trust.state] : ShieldQuestion
  const verifiedOn = trust?.verifiedAt ? new Date(trust.verifiedAt).toLocaleDateString() : null
  const text =
    error !== null
      ? 'The security key cannot be read now.'
      : !trust
        ? 'Reading the security key…'
        : trust.state === 'verified'
          ? `You compared safety numbers${verifiedOn ? ` on ${verifiedOn}` : ''}. Hachiman will tell you if this key ever changes.`
          : trust.state === 'changed'
            ? `The security key of ${name} changed. Compare safety numbers again.`
            : trust.state === 'tofu'
              ? 'Compare safety numbers once, in person or on a call, so nobody can sit in between.'
              : `Hachiman has no security key for ${name} yet.`
  const canVerify = trust !== null && (trust.state === 'tofu' || trust.state === 'changed')
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="section-label">Security key</h3>
      <div className={cn('flex flex-col gap-2 border p-3', look?.card ?? 'border-line-hairline')}>
        <span
          className={cn(
            'flex items-center gap-1.5 text-[13px] font-bold',
            look?.text ?? 'text-text-tertiary'
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {look?.label ?? 'Security key'}
        </span>
        <p className="text-text-secondary text-xs leading-[18px]">{text}</p>
        {safety && trust && trust.state !== 'unknown' && (
          <p
            className="text-text-primary grid grid-cols-4 gap-x-2 font-mono text-[11.5px] leading-5 font-semibold tabular-nums"
            aria-label="Safety number"
          >
            {safety.groups.map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </p>
        )}
        {canVerify && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openDialog({ kind: 'verification', userId })}
          >
            <ShieldCheck /> Verify {name}
          </Button>
        )}
      </div>
    </section>
  )
}

function Devices({
  devices,
  verified
}: {
  devices: ContactDevice[]
  verified: boolean
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="section-label">Devices · {devices.length}</h3>
      <ul className="flex flex-col gap-2">
        {devices.map((d) => (
          <li key={d.deviceId} className="flex items-center gap-2.5">
            <span className="bg-surface-raised text-text-secondary flex size-8 shrink-0 items-center justify-center">
              <MonitorSmartphone className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-text-primary truncate text-[13px] font-semibold">
                {d.displayName}
              </span>
              <span className="text-text-tertiary truncate text-xs">
                added {new Date(d.issuedAtMs).toLocaleDateString()}
              </span>
            </span>
            {verified && (
              <ShieldCheck
                className="text-feature-voice-text size-4 shrink-0"
                aria-label="Verified"
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
