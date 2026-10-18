import { Crown } from 'lucide-react'
import type { Channel, User } from '@hachiman/client'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { NotifyButton } from '@/components/notify/notify-menu'
import { AddPeopleButton } from '@/components/people/add-people-button'
import { CustomStatusLine } from '@/components/people/custom-status-line'
import { GroupSettingsButton } from '@/components/people/group-dm-settings'
import { PinsButton } from '@/components/pins/pins-button'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SystemTag } from '@/components/ui/system-tag'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { usePresence } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { useUserStore } from '@/stores/userStore'

/**
 * The people of a group DM, for the right column: me and the recipients, the owner with a crown.
 * There are no roles or sections; a click opens the profile card (no guild: identity and presence).
 * In the mobile drawer, Add people, Group settings, Pins and Notify sit in a row of 36 buttons on
 * top, as in the 1:1 profile drawer: the phone header keeps only Call and the drawer toggle.
 */
export function GroupDmMembers({
  channel,
  drawer
}: {
  channel: Channel
  drawer: boolean
}): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const people: User[] = [...(me ? [me] : []), ...(channel.recipients ?? [])]
  return (
    <aside
      aria-label="Members"
      className={cn(
        'bg-surface-panel border-line-hairline flex h-full min-h-0 shrink-0 flex-col',
        drawer ? 'w-full' : 'w-[252px] border-l'
      )}
    >
      {drawer && (
        <div className="flex items-center gap-2 px-4 pt-4">
          <AddPeopleButton channel={channel} className={ACTION_BUTTON} />
          <GroupSettingsButton channel={channel} className={ACTION_BUTTON} />
          <PinsButton channel={channel} />
          <NotifyButton channel={channel} />
        </div>
      )}
      <h2 className="text-text-tertiary px-4 pt-4 pb-2 text-xs font-bold tracking-wide uppercase">
        Members — {people.length}
      </h2>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col px-2 pb-3">
          {people.map((u) => (
            <GroupMemberRow
              key={u.id}
              user={u}
              owner={u.id === channel.ownerId}
              me={u.id === me?.id}
            />
          ))}
        </ul>
      </ScrollArea>
    </aside>
  )
}

/** A button of the drawer row: 36, the look of the mobile header buttons. */
const ACTION_BUTTON = cn(KIT_ICON_BUTTON, 'text-text-secondary active:bg-surface-hover')

function GroupMemberRow({
  user,
  owner,
  me
}: {
  user: User
  owner: boolean
  me: boolean
}): React.JSX.Element {
  const status = usePresence(user.id)
  return (
    <li>
      <UserProfilePopover userId={user.id} guildId={null} user={user}>
        <button
          type="button"
          className={cn(
            'rounded-control hover:bg-surface-hover flex min-h-[42px] w-full items-center gap-2.5 px-2 py-1 text-left',
            'mobile:active:bg-surface-hover',
            'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:-outline-offset-2'
          )}
        >
          <UserAvatar
            avatar={user.avatar}
            name={user.username}
            status={status}
            cutout="bg-surface-panel"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-text-primary truncate text-sm leading-5 font-semibold">
                {user.username}
              </span>
              {owner && (
                <Crown
                  className="text-feature-event-text size-3.5 shrink-0"
                  aria-label="Group owner"
                />
              )}
              {me && <SystemTag kind="you" />}
            </span>
            <CustomStatusLine userId={user.id} />
          </span>
        </button>
      </UserProfilePopover>
    </li>
  )
}
