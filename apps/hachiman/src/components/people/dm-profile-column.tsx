import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Crown, Hand, MonitorSmartphone, Phone, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { ContactDevice } from '@hachiman/crypto'
import type { Channel, Guild, Role, User } from '@hachiman/client'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { NotifyButton } from '@/components/notify/notify-menu'
import { PinsButton } from '@/components/pins/pins-button'
import { CustomStatusLine } from '@/components/people/custom-status-line'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { VoiceActivityLine } from '@/components/people/voice-activity-line'
import { useCanJoinVoice } from '@/components/voice/use-call-security'
import { useElapsed } from '@/hooks/use-elapsed'
import { useUserBanner } from '@/components/people/use-user-banner'
import { useMobileKeyChange } from '@/components/people/trust-chip'
import { lookFor, securityText } from '@/components/people/trust-look'
import { useMutualGuilds } from '@/components/people/use-mutual-guilds'
import { useContactSecurity, type ContactSecurity } from '@/components/people/use-contact-security'
import type { RightColumnVariant } from '@/components/people/right-column'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { GuildTile } from '@/components/ui/guild-tile'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAction } from '@/hooks/use-action'
import { usePresence } from '@/hooks/use-member'
import type { VoiceActivity } from '@/lib/member-activity'
import { displayName, hexColor, memberRoles } from '@/lib/model'
import { ROLE_INK_SCOPE, roleInk } from '@/lib/role-ink'
import { formatDayMonth } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { usePoke } from '@/services/poke'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { openChannel, selectGuild, useSelectedChannelId } from '@/stores/navStore'

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
 * The `drawer` variant fills the right drawer on a phone (no border). Poke, Pins and Notify,
 * which the desktop DM header holds, sit there as a row of 36 buttons under the name (I2).
 */
export function DmProfileColumn({
  user,
  variant = 'column',
  className
}: {
  user: User
  variant?: RightColumnVariant
  className?: string
}): React.JSX.Element {
  const userId = user.id
  const status = usePresence(userId)
  const mutual = useMutualGuilds(userId)
  const standing = useStanding(userId, mutual)
  const owner = mutual.some((g) => g.ownerId === userId)
  const activity = useVoiceActivity(userId, null)
  const security = useContactSecurity(userId)
  const name = displayName(undefined, user)
  const banner = useUserBanner(userId, user.avatar)

  return (
    <aside
      aria-label={`Profile of ${name}`}
      className={cn(
        'bg-surface-panel border-line-hairline flex h-full min-h-0 shrink-0 flex-col',
        variant === 'drawer' ? 'w-full' : 'w-[252px] border-l',
        ROLE_INK_SCOPE,
        className
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="h-24" style={{ background: banner }} aria-hidden />
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
            <CustomStatusLine userId={userId} className="mt-1 text-[13px] leading-5" />
          </div>

          {variant === 'drawer' && <DrawerActions user={user} />}

          {activity && <ActivityCard activity={activity} />}

          <SecurityCard
            name={name}
            userId={userId}
            security={security}
            dayOf={variant === 'drawer' ? formatDayMonth : localeDay}
          />

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

/** The Poke button of the drawer row: 36, the look of the mobile header buttons. */
const ACTION_BUTTON = cn(KIT_ICON_BUTTON, 'text-text-secondary active:bg-surface-hover')

/**
 * The selected channel when it is the 1:1 DM with `userId`: the right drawer shows the profile of
 * the open DM, and its Pins and Notify act on that DM.
 */
function useOpenDmWith(userId: string): Channel | undefined {
  const channelId = useSelectedChannelId()
  return useChannelStore((s) => {
    const c = channelId ? s.channels.get(channelId) : undefined
    return c?.type === 'dm' && c.recipients?.[0]?.id === userId ? c : undefined
  })
}

/**
 * Poke, Pins and Notify of the open DM in the mobile profile drawer (the desktop header has
 * them). Pins and Notify open as sheets over the drawer. A poke that fails says why below the row;
 * touch has no tooltip.
 */
function DrawerActions({ user }: { user: User }): React.JSX.Element {
  const poke = usePoke()
  const dm = useOpenDmWith(user.id)
  const status = poke.error ?? (poke.sent ? 'Poke sent!' : null)
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Poke ${user.username}`}
          disabled={poke.busy}
          onClick={() => void poke.run(user.id, user.username)}
          className={ACTION_BUTTON}
        >
          <Hand />
        </button>
        {dm && <PinsButton channel={dm} />}
        {dm && <NotifyButton channel={dm} />}
      </div>
      <p
        role="status"
        className={cn(
          'text-[12.5px] leading-4 font-medium not-empty:mt-1.5',
          poke.error ? 'text-feature-danger-text' : 'text-text-secondary'
        )}
      >
        {status}
      </p>
    </div>
  )
}

function ActivityCard({ activity }: { activity: VoiceActivity }): React.JSX.Element {
  const channel = useChannelStore((s) => s.channels.get(activity.channelId))
  const canJoin = useCanJoinVoice(activity.guildId, activity.channelId)
  const { run, busy } = useAction()
  const timer = useElapsed(activity.joinedAt ? Date.parse(activity.joinedAt) : null)
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
      <div className="flex min-w-0 flex-col">
        <VoiceActivityLine
          activity={activity}
          className="text-text-primary [&_svg]:text-feature-voice-text gap-2.5 text-[13px] font-bold"
        />
        {detail.length > 0 && (
          <span className="text-feature-voice-text truncate pl-6 text-xs tabular-nums">
            {detail.join(' · ')}
          </span>
        )}
      </div>
      {!activity.withMe && channel && (
        <Button variant="voice" size="sm" disabled={busy || !canJoin} onClick={join}>
          <Phone /> Join
        </Button>
      )}
    </div>
  )
}

/** The day of a verification in the desktop column: the locale's full date. */
function localeDay(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleDateString() : null
}

function SecurityCard({
  name,
  userId,
  security,
  dayOf
}: {
  name: string
  userId: string
  security: ContactSecurity
  /** Formats TrustInfo.verifiedAt for the explainer. */
  dayOf: (iso: string | null) => string | null
}): React.JSX.Element {
  const { trust, safety, error } = security
  const keyChange = useMobileKeyChange(userId)
  const look = trust ? lookFor(trust.state, keyChange) : null
  const Icon = look?.Icon ?? ShieldQuestion
  const text = securityText({
    name,
    state: trust?.state ?? null,
    keyChange,
    verifiedOn: dayOf(trust?.verifiedAt ?? null),
    error
  })
  const canVerify = look?.canVerify ?? false
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
