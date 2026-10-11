import { useId, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Copy, Hash } from 'lucide-react'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { useUserBanner } from '@/components/people/use-user-banner'
import { ImageField } from '@/components/settings/image-field'
import { UserAvatar } from '@/components/shell/user-avatar'
import { IconButton } from '@/components/ui/icon-button'
import { useCopy } from '@/hooks/use-copy'
import { useLayout } from '@/hooks/use-layout'
import { memberRoles } from '@/lib/model'
import { orderedIds } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { PROFILE_IMAGE_FORMATS } from '@/services/UploadService'
import { usePlatform } from '@/shared/PlatformContext'
import { useGuildStore } from '@/stores/guildStore'
import { useGuildOrder } from '@/stores/prefsStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

/** User settings → My account: the desktop page (H1), or the phone screen (M30). */
export function AccountSection(): React.JSX.Element {
  return useLayout() === 'mobile' ? <AccountMobile /> : <AccountDesktop />
}

/** H1: profile card with the account details, and the avatar. */
function AccountDesktop(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  const name = me?.username ?? takusenUser?.handle ?? 'Unknown'

  return (
    <div className="grid gap-6">
      <div className="bg-surface-panel border-line-hairline border">
        <div className="from-accent-primary to-accent-primary/50 h-[92px] bg-gradient-to-r" />
        <div className="flex items-end gap-4 px-4">
          <UserAvatar
            name={name}
            avatar={me?.avatar}
            size={96}
            className="ring-surface-panel -mt-12 rounded-full ring-[5px]"
          />
          <p className="text-section-title min-w-0 flex-1 truncate pb-2">{name}</p>
        </div>
        <dl className="divide-line-hairline mt-3 grid divide-y px-4 pb-1">
          <AccountRow label="Username" value={name} mono />
          <AccountRow
            label="Email"
            value={takusenUser?.email || 'Not shared by your Takusen account'}
          />
          {me && <AccountRow label="User ID" value={me.id} mono copy />}
        </dl>
      </div>
      {me && (
        <ImageField
          row
          label="Avatar"
          hint={`${PROFILE_IMAGE_FORMATS}. Shown as a circle.`}
          value={me.avatar}
          fallback={name.slice(0, 1).toUpperCase()}
          onSave={(avatar) => hachiman.rest.updateMe({ avatar })}
        />
      )}
    </div>
  )
}

function AccountRow({
  label,
  value,
  mono,
  copy
}: {
  label: string
  value: string
  mono?: boolean
  /** Shows a copy button. */
  copy?: boolean
}): React.JSX.Element {
  const { copied, copy: copyValue } = useCopy()
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <dt className="section-label">{label}</dt>
        <dd className={cn('truncate', mono ? 'font-mono text-[14px]' : 'text-sm')}>{value}</dd>
      </div>
      {copy && (
        <IconButton
          label={copied !== null ? 'Copied' : `Copy ${label.toLowerCase()}`}
          className="rounded-control border-line-hairline size-8 border"
          onClick={() => copyValue(value)}
        >
          {copied !== null ? <Check className="text-feature-voice-text" /> : <Copy />}
        </IconButton>
      )}
    </div>
  )
}

/** The profile card shows the top role of at most this many guilds. */
const ROLE_LINES = 2
const NO_ROLE_LINES: { guildId: string; text: string }[] = []

/** "Shotcaller in Night Owls": my highest role in each guild where I have one, in my guild order. */
function useRoleLines(userId: string | undefined): { guildId: string; text: string }[] {
  const { guilds, members, roles } = useGuildStore(
    useShallow((s) => ({ guilds: s.guilds, members: s.members, roles: s.roles }))
  )
  const order = useGuildOrder()
  return useMemo(() => {
    if (!userId) return NO_ROLE_LINES
    const lines: { guildId: string; text: string }[] = []
    for (const guildId of orderedIds([...guilds.keys()], order)) {
      const guild = guilds.get(guildId)
      const top = memberRoles(members.get(guildId)?.get(userId), roles.get(guildId))[0]
      if (guild && top) lines.push({ guildId, text: `${top.name} in ${guild.name}` })
      if (lines.length === ROLE_LINES) break
    }
    return lines
  }, [userId, guilds, members, roles, order])
}

/**
 * M30: the profile card (banner, avatar with the camera badge, name and roles), then the Takusen
 * account the profile comes from. Colour, display name, about and Save stay hidden until the
 * server has those fields (spec §5).
 */
function AccountMobile(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  const name = me?.username ?? takusenUser?.handle ?? 'Unknown'
  const banner = useUserBanner(me?.id ?? '', me?.avatar)
  const roleLines = useRoleLines(me?.id)
  const takusenLabel = useId()

  const identity = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-2">
      <p className="text-text-primary truncate text-xl leading-6 font-extrabold">{name}</p>
      {roleLines.map((line) => (
        <p
          key={line.guildId}
          className="text-text-tertiary truncate text-[12.5px] leading-[18px] font-semibold"
        >
          {line.text}
        </p>
      ))}
    </div>
  )

  return (
    <div className="grid gap-4">
      <div className="bg-surface-panel border-line-hairline border">
        <div aria-hidden className="h-16" style={{ background: banner }} />
        <div className="px-3.5 pb-3.5">
          {me ? (
            <ImageField
              variant="badge"
              label="Avatar"
              value={me.avatar}
              fallback={name.slice(0, 1).toUpperCase()}
              onSave={(avatar) => hachiman.rest.updateMe({ avatar })}
            >
              {identity}
            </ImageField>
          ) : (
            <div className="flex items-start gap-4">
              <UserAvatar
                name={name}
                size={72}
                className="ring-surface-panel -mt-9 rounded-full ring-[5px]"
              />
              {identity}
            </div>
          )}
        </div>
      </div>

      <section aria-labelledby={takusenLabel} className="flex flex-col gap-1.5">
        <SectionLabel id={takusenLabel}>Takusen account</SectionLabel>
        <ListGroup>
          <ListRow
            href={`${takusenService.env.issuerOrigin}/account`}
            icon={<span className="text-base leading-none font-bold">T</span>}
            tile="event"
            label="Signed in with Takusen"
            detail={takusenUser?.email || 'Email not shared'}
          />
          {me && <UserIdRow id={me.id} />}
        </ListGroup>
        <p className="text-text-tertiary px-1 text-[12.5px] leading-[18px] font-medium">
          Your email and password live in Takusen. Change them there.
        </p>
      </section>
    </div>
  )
}

/** A tap copies the id, with a success haptic. The live region tells VoiceOver the result. */
function UserIdRow({ id }: { id: string }): React.JSX.Element {
  const platform = usePlatform()
  const { copied, failed, copy } = useCopy()
  const mark = 'size-[17px] shrink-0'
  return (
    <div className="flex flex-col">
      <ListRow
        icon={<Hash />}
        tile="neutral"
        label="User ID"
        chevron={false}
        onClick={() =>
          copy(() => navigator.clipboard.writeText(id).then(() => platform.haptic('success')))
        }
        value={
          <span className="flex items-center gap-3">
            <span className="text-text-secondary font-mono">{id}</span>
            <span className="sr-only">, copy</span>
            {copied !== null ? (
              <Check aria-hidden className={cn(mark, 'text-feature-voice-text')} />
            ) : (
              <Copy
                aria-hidden
                className={cn(mark, failed ? 'text-feature-danger-text' : 'text-text-disabled')}
              />
            )}
          </span>
        }
      />
      <span className="sr-only" aria-live="polite">
        {copied !== null ? 'Copied' : failed ? 'Could not copy' : ''}
      </span>
    </div>
  )
}
