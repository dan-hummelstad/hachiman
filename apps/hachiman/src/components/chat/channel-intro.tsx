import { useRef } from 'react'
import {
  CornerUpLeft,
  Lock,
  MessagesSquare,
  Pin,
  Settings,
  ShieldQuestion,
  Upload,
  UserPlus,
  Users
} from 'lucide-react'
import { Permissions, has, type Channel, type Role } from '@hachiman/client'
import { HeaderChannelIcon } from '@/components/shell/channel-pane'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { FEATURE_TILE } from '@/components/ui/feature'
import { usePermissions } from '@/hooks/use-hachiman'
import { usePresence } from '@/hooks/use-member'
import { channelLabel, hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'
import { jumpToMessage, openChannelView } from '@/components/pins/jump'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import { openSettings } from '@/stores/navStore'
import { pinTab, useIsPinned, type TabTarget } from '@/stores/tabsStore'
import { useChannelAccess } from '@/lib/channel-access'
import { TRUST_LOOK } from '@/components/people/trust-look'
import { useContactTrust } from '@/components/people/use-contact-trust'

/** The quiet intro buttons: hairline outline, hover wash. */
const INTRO_BUTTON = 'border-line-hairline text-text-primary'

/**
 * The start of a channel (shown once all history is loaded): a square icon tile, "Welcome to
 * #name", the topic and the actions this user may take. A restricted channel lists the roles that
 * can see it, and an empty channel offers the first upload. An unpinned channel offers "Pin to
 * tabs" (N1, B5) in front of "Invite people".
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
  if (channel.guildId === null) return <DmIntro channel={channel} />
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
      {(!pinned || canInvite || canManage) && (
        <div className="mt-4 flex flex-wrap gap-2">
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
