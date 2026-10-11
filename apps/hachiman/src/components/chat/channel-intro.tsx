import { useRef } from 'react'
import {
  CornerUpLeft,
  FilePlus,
  Loader2,
  Lock,
  MessagesSquare,
  Pin,
  Settings,
  ShieldCheck,
  ShieldQuestion,
  Upload,
  UserPlus,
  Users
} from 'lucide-react'
import { Permissions, has, type Channel, type Role, type User } from '@hachiman/client'
import type { SenderTrust } from '@hachiman/crypto'
import { HeaderChannelIcon } from '@/components/shell/channel-pane'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { FEATURE_TILE } from '@/components/ui/feature'
import { usePermissions } from '@/hooks/use-hachiman'
import { usePresence } from '@/hooks/use-member'
import { channelLabel, hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'
import { jumpToMessage, openChannelView } from '@/lib/navigation'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import { openSettings } from '@/stores/navStore'
import { pinTab, useIsPinned, type TabTarget } from '@/stores/tabsStore'
import { useChannelAccess } from '@/lib/channel-access'
import { KeyCard } from '@/components/chat/key-card'
import { useMobileKeyChange } from '@/components/people/trust-chip'
import { TRUST_LOOK, shownTrust } from '@/components/people/trust-look'
import { useContactTrust } from '@/components/people/use-contact-trust'
import { useMutualGuilds } from '@/components/people/use-mutual-guilds'
import { GuildTile } from '@/components/ui/guild-tile'
import { useLayout } from '@/hooks/use-layout'
import { useNewPage } from '@/services/docs/use-channel-pages'

/** The quiet intro buttons: hairline outline, hover wash. 36 high on the mobile layout (§2.10). */
const INTRO_BUTTON = 'border-line-hairline text-text-primary mobile:h-9'

/**
 * The start of a channel (shown once all history is loaded): a square icon tile, "Welcome to
 * #name", the topic and the actions this user may take. A restricted channel lists the roles that
 * can see it, and an empty channel offers the first upload. An unpinned channel offers "Pin to
 * tabs" (N1, B5) in front of "Invite people". A DM on the mobile layout has its own start (M7,
 * M57); the desktop one does not change.
 */
export function ChannelIntro({
  channel,
  empty,
  onUpload
}: {
  channel: Channel
  /** No messages at all: show the drop card. */
  empty: boolean
  /** ATTACH_FILES: the drop card's upload button. */
  onUpload?: (files: File[]) => void
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  if (channel.guildId === null)
    return mobile ? <MobileDmIntro channel={channel} /> : <DmIntro channel={channel} />
  if (channel.type === 'thread') return <ThreadIntro thread={channel} />
  return <GuildIntro channel={channel} empty={empty} onUpload={onUpload} />
}

function GuildIntro({
  channel,
  empty,
  onUpload
}: {
  channel: Channel
  empty: boolean
  onUpload?: (files: File[]) => void
}): React.JSX.Element {
  const { name } = channelLabel(channel)
  const access = useChannelAccess(channel)
  const perms = usePermissions(channel.guildId, channel.id)
  const canInvite = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const canManage = has(perms, Permissions.MANAGE_CHANNELS)
  // Mobile only (spec §6.1): a pages channel opens on its chat there, so its start offers a page.
  const mobile = useLayout() === 'mobile'
  const canWritePage = mobile && channel.type === 'pages' && has(perms, Permissions.SEND_MESSAGES)
  const newPage = useNewPage(channel)
  const tile = access.readOnly
    ? FEATURE_TILE.event
    : channel.type === 'pages'
      ? FEATURE_TILE.page
      : FEATURE_TILE.accent
  const tab: TabTarget = { kind: 'channel', id: channel.id, guildId: channel.guildId }
  const pinned = useIsPinned(tab)
  const settings = (): void => openSettings({ kind: 'channel', channelId: channel.id })
  const manageAccess = (): void =>
    openSettings({ kind: 'channel', channelId: channel.id }, 'permissions')

  return (
    <div className="px-5 pt-10 pb-4">
      <div className={cn('mb-4 flex size-16 items-center justify-center', tile)}>
        <HeaderChannelIcon
          channel={channel}
          readOnly={access.readOnly}
          className="size-8 text-current"
        />
      </div>
      <h2 className="text-page-title text-text-primary">Welcome to #{name}</h2>
      {channel.topic && (
        <p className="text-body text-text-secondary mt-1.5 max-w-[70ch]">{channel.topic}</p>
      )}
      {(!pinned || canInvite || canManage || canWritePage) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canWritePage && (
            <Button
              variant="quiet"
              className={INTRO_BUTTON}
              disabled={newPage.busy}
              onClick={newPage.create}
            >
              {newPage.busy ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <FilePlus aria-hidden />
              )}
              New page
            </Button>
          )}
          {!pinned && (
            <Button variant="quiet" className={INTRO_BUTTON} onClick={() => pinTab(tab)}>
              <Pin aria-hidden />
              Pin to tabs
            </Button>
          )}
          {canInvite && (
            <Button
              variant="quiet"
              className={INTRO_BUTTON}
              onClick={() => openDialog({ kind: 'invite', guildId: channel.guildId! })}
            >
              <UserPlus aria-hidden />
              Invite people
            </Button>
          )}
          {canManage && (
            <Button variant="quiet" className={INTRO_BUTTON} onClick={settings}>
              <Settings aria-hidden />
              Edit channel
            </Button>
          )}
        </div>
      )}
      {newPage.error !== null && (
        <p role="alert" className="text-feature-danger-text mt-2 text-xs leading-4">
          {newPage.error}
        </p>
      )}
      {access.restricted && (
        <RestrictedCard
          name={name}
          roles={access.viewers}
          onManage={canManage ? manageAccess : undefined}
        />
      )}
      {empty && !access.restricted && onUpload && <DropCard name={name} onUpload={onUpload} />}
    </div>
  )
}

/** The start of a thread: its name, "Thread in #parent" and a link to the message it started from. */
function ThreadIntro({ thread }: { thread: Channel }): React.JSX.Element {
  const parent = useChannelStore((s) =>
    thread.parentId ? s.channels.get(thread.parentId) : undefined
  )
  const startId = thread.threadStartMessageId ?? null
  return (
    <div className="px-5 pt-10 pb-4">
      <div className={cn('mb-4 flex size-16 items-center justify-center', FEATURE_TILE.thread)}>
        <MessagesSquare className="size-8" aria-hidden />
      </div>
      <h2 className="text-page-title text-text-primary">{thread.name}</h2>
      {parent && (
        <p className="text-body text-text-secondary mt-1.5 max-w-[70ch]">
          Thread in{' '}
          <button
            type="button"
            onClick={() => openChannelView(parent)}
            className="text-text-primary rounded-control focus-visible:outline-line-focus font-semibold outline-none hover:underline focus-visible:outline-2"
          >
            #{channelLabel(parent).name}
          </button>
          . Messages are end-to-end encrypted.
        </p>
      )}
      {parent && startId && (
        <div className="mt-4 flex gap-2">
          <Button
            variant="quiet"
            className={INTRO_BUTTON}
            onClick={() => jumpToMessage(parent, startId)}
          >
            <CornerUpLeft aria-hidden />
            Jump to the start message
          </Button>
        </div>
      )}
    </div>
  )
}

/** B9: who can see a channel that @everyone cannot. */
function RestrictedCard({
  name,
  roles,
  onManage
}: {
  name: string
  roles: Role[]
  onManage?: () => void
}): React.JSX.Element {
  return (
    <section className="bg-surface-panel border-line-hairline mt-5 max-w-[520px] border px-4 py-3">
      <div className="flex items-center gap-2">
        <Lock className="text-text-secondary size-4 shrink-0" aria-hidden />
        <h3 className="text-label text-text-primary flex-1 font-bold">Restricted channel</h3>
        {onManage && (
          <Button variant="link" size="sm" onClick={onManage}>
            Manage access
          </Button>
        )}
      </div>
      <p className="text-text-secondary mt-1.5 text-[13.5px] leading-5">
        {roles.length > 0
          ? `Only these roles can see #${name} and read its history.`
          : `Only the people with access granted to them can see #${name}.`}
      </p>
      {roles.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {roles.map((r) => (
            <li
              key={r.id}
              className="rounded-check bg-surface-raised text-text-primary flex h-6 items-center gap-1.5 px-2 text-xs font-bold"
            >
              <span
                aria-hidden
                className="size-2 shrink-0"
                style={{ background: r.color ? hexColor(r.color) : 'var(--text-tertiary)' }}
              />
              {r.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** B6: the empty channel's first step, through the same upload tray as the composer. */
function DropCard({
  name,
  onUpload
}: {
  name: string
  onUpload: (files: File[]) => void
}): React.JSX.Element {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <section className="bg-surface-panel border-line-hairline mt-5 flex items-center gap-4 border px-5 py-4">
      <div className={cn('flex size-11 shrink-0 items-center justify-center', FEATURE_TILE.accent)}>
        <Upload className="size-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-label text-text-primary font-bold">No messages yet</h3>
        <p className="text-text-secondary text-[13.5px] leading-5">
          Drop files here or paste them into the message box. They stay end-to-end encrypted in #
          {name}.
        </p>
      </div>
      <Button onClick={() => picker.current?.click()}>
        <Upload aria-hidden />
        Upload
      </Button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          onUpload([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
    </section>
  )
}

/** E2: the start of a DM, with the other person's avatar and a verify step until verified. */
function DmIntro({ channel }: { channel: Channel }): React.JSX.Element {
  const { name } = channelLabel(channel)
  const recipients = channel.recipients ?? []
  const solo = recipients.length === 1 ? recipients[0] : undefined
  const status = usePresence(solo?.id)
  const { trust } = useContactTrust(solo?.id)
  return (
    <div className="px-5 pt-10 pb-4">
      {solo ? (
        <UserAvatar
          name={name}
          avatar={solo.avatar}
          size={72}
          status={status}
          cutout="bg-surface-content"
          className="mb-4"
        />
      ) : (
        <div className={cn('mb-4 flex size-16 items-center justify-center', FEATURE_TILE.accent)}>
          <Users className="size-8" aria-hidden />
        </div>
      )}
      <h2 className="text-page-title text-text-primary">{name}</h2>
      <p className="text-body text-text-secondary mt-1.5 max-w-[70ch]">
        This is the start of your conversation with {name}. Messages are end-to-end encrypted.
      </p>
      {solo && trust && TRUST_LOOK[trust.state].canVerify && (
        <div className="mt-4 flex gap-2">
          <Button
            variant="quiet"
            className="border-feature-event/50 text-feature-event-text"
            onClick={() => openDialog({ kind: 'verification', userId: solo.id })}
          >
            <ShieldQuestion aria-hidden />
            Verify {name}
          </Button>
        </div>
      )}
    </div>
  )
}

/** At most this many mutual guild chips in the mobile DM intro; the rest is "+n". */
const MUTUAL_CHIPS = 3

/** The 30 high chips of the mobile DM intro (M7). */
const INTRO_CHIP =
  'rounded-control inline-flex h-[30px] max-w-full min-w-0 shrink-0 items-center gap-[7px] border text-[13.5px] leading-none font-bold'

/** The wash and edge of a quiet intro chip (the mutual guilds, "+n", "No key yet"). */
const MUTUAL_CHIP = 'bg-surface-hover border-(--fill-control)'

/** The Verify chip per shown trust state: gold for "Not verified", red for a blocking change. */
const VERIFY_TINT: Partial<Record<SenderTrust, string>> = {
  tofu: 'border-feature-event/22 bg-feature-event/10 text-feature-event-text',
  changed: 'border-feature-danger/22 bg-feature-danger/10 text-feature-danger-text'
}

/**
 * The start of a DM on the mobile layout (M7, M57): the avatar (72), the name (28/800), the
 * end-to-end line, the mutual guilds as chips (at most 3, then "+n") with the trust chip of the
 * state, and the key card once the contact is verified.
 */
function MobileDmIntro({ channel }: { channel: Channel }): React.JSX.Element {
  const { name } = channelLabel(channel)
  const recipients = channel.recipients ?? []
  const solo = recipients.length === 1 ? recipients[0] : undefined
  const status = usePresence(solo?.id)
  return (
    <div className="flex flex-col gap-2.5 px-4 pt-6 pb-3">
      {solo ? (
        <UserAvatar
          name={name}
          avatar={solo.avatar}
          size={72}
          status={status}
          cutout="bg-surface-content"
        />
      ) : (
        <div className={cn('flex size-[72px] items-center justify-center', FEATURE_TILE.accent)}>
          <Users className="size-9" aria-hidden />
        </div>
      )}
      <h2 className="text-text-primary max-w-full truncate text-[28px] leading-[34px] font-extrabold tracking-[-0.3px]">
        {name}
      </h2>
      <p className="text-text-secondary text-[15px] leading-[1.45] font-medium">
        This is the start of your conversation with {name}. Messages are end-to-end encrypted.
      </p>
      {solo && <MobileDmIntroTrust user={solo} name={name} />}
    </div>
  )
}

/** The mutual guild chips, the trust chip and the key card of a 1:1 DM. */
function MobileDmIntroTrust({ user, name }: { user: User; name: string }): React.JSX.Element {
  const mutual = useMutualGuilds(user.id)
  const { trust } = useContactTrust(user.id)
  const keyChange = useMobileKeyChange(user.id)
  const shown = trust ? shownTrust(trust.state, keyChange) : null
  const more = mutual.length - MUTUAL_CHIPS
  const verifyTint = shown ? VERIFY_TINT[shown] : undefined
  return (
    <>
      {(mutual.length > 0 || (shown !== null && shown !== 'verified')) && (
        <ul aria-label="Mutual guilds and trust" className="flex max-w-full flex-wrap gap-2 pt-1">
          {mutual.slice(0, MUTUAL_CHIPS).map((g) => (
            <li key={g.id} className={cn(INTRO_CHIP, MUTUAL_CHIP, 'pr-3 pl-2')}>
              <GuildTile guild={g} className="size-[18px] border-0 text-[7.5px]" />
              <span className="text-text-primary truncate">{g.name}</span>
            </li>
          ))}
          {more > 0 && (
            <li className={cn(INTRO_CHIP, MUTUAL_CHIP, 'text-text-secondary px-3')}>
              <span aria-hidden>+{more}</span>
              <span className="sr-only">{more} more mutual guilds</span>
            </li>
          )}
          {verifyTint && (
            <li className="max-w-full min-w-0">
              <button
                type="button"
                onClick={() => openDialog({ kind: 'verification', userId: user.id })}
                className={cn(
                  INTRO_CHIP,
                  verifyTint,
                  // The 30 high chip in a 36 hit area (spec §2.10).
                  'relative pr-3 pl-2.5 after:absolute after:-inset-y-[3px] after:inset-x-0 active:brightness-125',
                  'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:outline-offset-1'
                )}
              >
                <ShieldCheck className="size-[15px] shrink-0" aria-hidden />
                <span className="truncate">
                  {shown === 'changed' ? `Verify ${name} again` : `Verify ${name}`}
                </span>
              </button>
            </li>
          )}
          {shown === 'unknown' && (
            <li className={cn(INTRO_CHIP, MUTUAL_CHIP, 'text-text-tertiary pr-3 pl-2.5')}>
              <ShieldQuestion className="size-[15px] shrink-0" aria-hidden />
              {TRUST_LOOK.unknown.label}
            </li>
          )}
        </ul>
      )}
      {trust?.state === 'verified' && <KeyCard name={name} verifiedAt={trust.verifiedAt} />}
    </>
  )
}
