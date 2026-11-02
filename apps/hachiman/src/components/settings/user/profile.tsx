import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Copy, Ellipsis, Hash } from 'lucide-react'
import { ListRow } from '@/components/mobile/list'
import { useUserStore } from '@/stores/userStore'
import {
  FieldBlock,
  MobileCap,
  MobileCard,
  MobileNote,
  READ_FIELD,
  ReadField,
  SettingsCap,
  SettingsRule,
  SpaceRow
} from '@/components/settings/user/rows'
import { useImageUpload } from '@/components/settings/use-image-upload'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { isStatus, OWN_STATUS_LABEL, PresenceDot, STATUSES } from '@/components/ui/presence'
import { useCopy } from '@/hooks/use-copy'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { useLayout } from '@/hooks/use-layout'
import { memberRoles } from '@/lib/model'
import { orderedIds } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'
import { hachiman, setMyStatus } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { PROFILE_IMAGE_FORMATS } from '@/services/UploadService'
import { usePlatform } from '@/shared/PlatformContext'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useSelectedGuildId } from '@/stores/navStore'
import { useGuildOrder } from '@/stores/prefsStore'
import { useTakusenStore } from '@/stores/takusenStore'

const STATUS_HINT = {
  online: 'Visible everywhere',
  idle: 'Shown as away',
  dnd: 'Shown as busy',
  offline: 'Shown as offline'
} as const

/** The roles preview shows the top role of at most this many guilds. */
const ROLE_CHIPS = 3
const NO_ROLES: string[] = []

/** My highest role name in each guild where I have one, in my guild order, without repeats. */
function useTopRoleNames(userId: string | undefined): string[] {
  const { guilds, members, roles } = useGuildStore(
    useShallow((s) => ({ guilds: s.guilds, members: s.members, roles: s.roles }))
  )
  const order = useGuildOrder()
  return useMemo(() => {
    if (!userId) return NO_ROLES
    const names: string[] = []
    for (const guildId of orderedIds([...guilds.keys()], order)) {
      const top = memberRoles(members.get(guildId)?.get(userId), roles.get(guildId))[0]
      if (top && !names.includes(top.name)) names.push(top.name)
      if (names.length === ROLE_CHIPS) break
    }
    return names
  }, [userId, guilds, members, roles, order])
}

/** User settings -> Profile: what other people see when they tap your name. */
export function ProfileSection(): React.JSX.Element {
  return useLayout() === 'mobile' ? <ProfileMobile /> : <ProfileDesktop />
}

function useMe(): { id: string | undefined; name: string; avatar: string | null | undefined } {
  const me = useUserStore((s) => s.me)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  return {
    id: me?.id,
    name: me?.username ?? takusenUser?.handle ?? 'Unknown',
    avatar: me?.avatar
  }
}

function useAvatarUpload(avatar: string | null | undefined): ReturnType<typeof useImageUpload> {
  return useImageUpload(avatar ?? null, (id) => hachiman.rest.updateMe({ avatar: id }))
}

function ProfileDesktop(): React.JSX.Element {
  const { id, name, avatar } = useMe()
  const status = useUserStore((s) => s.status)
  const custom = useCustomStatus(id ?? '')
  const roleNames = useTopRoleNames(id)
  const upload = useAvatarUpload(avatar)
  const selectedGuildId = useSelectedGuildId()
  const guildCount = useGuildStore((s) => s.guilds.size)

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_330px] gap-[34px]">
        <div>
          <SettingsCap>Your picture</SettingsCap>
          <div className="mt-2 flex items-center gap-4">
            {upload.src ? (
              <img src={upload.src} alt="" className="size-[72px] rounded-[18px] object-cover" />
            ) : (
              <UserAvatar name={name} size={72} className="rounded-[18px]" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" disabled={upload.busy} onClick={upload.pick}>
                  {upload.uploading ? 'Uploading…' : 'Upload a picture'}
                </Button>
                {avatar && (
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={upload.busy}
                    onClick={() => void upload.remove()}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-text-disabled mt-[7px] font-mono text-[9px] tracking-[0.9px] uppercase">
                {PROFILE_IMAGE_FORMATS}
              </p>
              {upload.error && (
                <p role="alert" className="text-you-text mt-1 text-[12.5px]">
                  {upload.error}
                </p>
              )}
            </div>
            <input {...upload.input} />
          </div>
          <FieldBlock label="Custom status" className="mt-5">
            <button
              type="button"
              disabled={!id}
              onClick={() => openDialog({ kind: 'customStatus' })}
              className={cn(READ_FIELD, 'hover:bg-surface-hover w-full text-left')}
            >
              {custom ? (
                <span className="truncate">{custom.text}</span>
              ) : (
                <span className="text-text-tertiary">Set a status</span>
              )}
            </button>
          </FieldBlock>
        </div>
        <div>
          <SettingsCap>How people see you</SettingsCap>
          <div
            aria-label="Preview of your profile"
            role="group"
            className="rounded-control bg-surface-raised mt-2 flex flex-col gap-[13px] p-4"
          >
            <div className="flex items-center gap-3">
              <UserAvatar name={name} avatar={avatar} size={52} className="rounded-[13px]" />
              <div className="min-w-0">
                <p className="text-text-primary truncate text-[17px] font-semibold">{name}</p>
                <p className="text-text-disabled font-mono text-[9px] uppercase">@{name}</p>
              </div>
            </div>
            {roleNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {roleNames.map((r) => (
                  <Chip key={r}>{r}</Chip>
                ))}
              </div>
            )}
            <div aria-hidden className="bg-line-hairline h-px" />
            {custom && <p className="text-text-tertiary text-[12.5px]">{custom.text}</p>}
            <p className="cap-sm">
              {guildCount} {guildCount === 1 ? 'SPACE' : 'SPACES'}
            </p>
            <div aria-hidden className="flex gap-2">
              <span className="rounded-control bg-ink text-on-ink pointer-events-none flex h-9 flex-1 items-center justify-center text-sm font-semibold">
                Message
              </span>
              <span className="rounded-control border-line-strong flex h-9 w-10 items-center justify-center border">
                <Ellipsis className="size-4" />
              </span>
            </div>
          </div>
          <SettingsCap className="mt-5">Status</SettingsCap>
          <div role="radiogroup" aria-label="Status" className="mt-2 grid gap-px">
            {STATUSES.map((s) => {
              const on = s === status
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => isStatus(s) && setMyStatus(s)}
                  className={cn(
                    'rounded-row flex h-[38px] items-center gap-2.5 px-2.5 text-left',
                    on ? 'bg-surface-selected' : 'hover:bg-surface-hover'
                  )}
                >
                  <PresenceDot status={s} className="size-2" />
                  <span
                    className={cn(
                      'text-[13px]',
                      on ? 'text-text-primary font-semibold' : 'text-text-secondary'
                    )}
                  >
                    {OWN_STATUS_LABEL[s]}
                  </span>
                  <span className="text-text-disabled font-mono text-[8.5px] tracking-[0.8px] uppercase">
                    {STATUS_HINT[s]}
                  </span>
                  {on && <Check aria-hidden className="ml-auto size-3.5" />}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <SettingsRule />
      <SettingsCap>What you are called in each space</SettingsCap>
      <div className="mt-2">
        <NicknameRows userId={id} selectedGuildId={selectedGuildId} />
      </div>
    </div>
  )
}

/** One row per space: the name people there see (nickname, else username). */
function NicknameRows({
  userId,
  selectedGuildId
}: {
  userId: string | undefined
  selectedGuildId: string | null
}): React.JSX.Element {
  const { guilds, members } = useGuildStore(
    useShallow((s) => ({ guilds: s.guilds, members: s.members }))
  )
  const order = useGuildOrder()
  const ids = useMemo(() => orderedIds([...guilds.keys()], order), [guilds, order])
  return (
    <>
      {ids.map((guildId) => {
        const guild = guilds.get(guildId)
        if (!guild) return null
        const member = userId ? members.get(guildId)?.get(userId) : undefined
        return (
          <SpaceRow
            key={guildId}
            guild={guild}
            memberCount={members.get(guildId)?.size}
            current={guildId === selectedGuildId}
            value={member?.nick ?? member?.user.username}
          />
        )
      })}
    </>
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
              <Check aria-hidden className={cn(mark, 'text-text-primary')} />
            ) : (
              <Copy
                aria-hidden
                className={cn(mark, failed ? 'text-you-text' : 'text-text-disabled')}
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

function ProfileMobile(): React.JSX.Element {
  const { id, name, avatar } = useMe()
  const status = useUserStore((s) => s.status)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  const custom = useCustomStatus(id ?? '')
  const upload = useAvatarUpload(avatar)

  return (
    <div className="grid gap-[18px]">
      <div className="flex items-center gap-3.5">
        {upload.src ? (
          <img src={upload.src} alt="" className="size-[72px] rounded-full object-cover" />
        ) : (
          <UserAvatar name={name} size={72} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-text-primary truncate text-[19px] font-semibold">{name}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={upload.busy}
              onClick={upload.pick}
              className="rounded-pill border-line-strong h-[34px] w-auto px-4 text-[12.5px] font-semibold"
            >
              {upload.uploading ? 'Uploading…' : 'Change photo'}
            </Button>
            {avatar && (
              <Button
                variant="quiet"
                disabled={upload.busy}
                onClick={() => void upload.remove()}
                className="h-[34px] w-auto px-2 text-[12.5px]"
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        <input {...upload.input} />
      </div>
      {upload.error && (
        <p role="alert" className="text-you-text text-[12.5px]">
          {upload.error}
        </p>
      )}
      <FieldBlock label="Handle">
        <ReadField prefix="@">{name}</ReadField>
        <MobileNote>People find you by this. It is the same everywhere in Hachiman.</MobileNote>
      </FieldBlock>

      <section className="flex flex-col gap-1.5">
        <MobileCap>Status</MobileCap>
        <MobileCard>
          <ListRow
            icon={<PresenceDot status={status} className="size-2.5" />}
            tile="neutral"
            label={OWN_STATUS_LABEL[status]}
            detail={custom?.text}
            onClick={() => openDialog({ kind: 'status' })}
          />
        </MobileCard>
      </section>

      <section className="flex flex-col gap-1.5">
        <MobileCap>What people see</MobileCap>
        <MobileCard className="p-3.5">
          <div aria-hidden className="flex items-start gap-2.5">
            <UserAvatar name={name} avatar={avatar} size={34} />
            <div className="min-w-0">
              <p className="text-text-primary text-[13.5px] font-semibold">{name}</p>
              <p className="text-text-secondary text-[12.5px]">
                {custom?.text ?? 'This is how your messages look.'}
              </p>
            </div>
          </div>
        </MobileCard>
      </section>

      <section className="flex flex-col gap-1.5">
        <MobileCap>Takusen account</MobileCap>
        <MobileCard>
          <ListRow
            href={`${takusenService.env.issuerOrigin}/account`}
            icon={<span className="text-base leading-none font-semibold">T</span>}
            tile="neutral"
            label="Signed in with Takusen"
            detail={takusenUser?.email || 'Email not shared'}
          />
          {id && <UserIdRow id={id} />}
        </MobileCard>
        <MobileNote>Your email and password live in Takusen. Change them there.</MobileNote>
      </section>
    </div>
  )
}
