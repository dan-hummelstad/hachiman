import {
  Bell,
  CalendarHeart,
  CirclePlus,
  FolderPlus,
  LogOut,
  Plus,
  Settings,
  Trash2,
  UserPlus
} from 'lucide-react'
import { Permissions, has } from '@hachiman/client'
import { useIsGuildOwner, usePermissions } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { guildNotifyLevel, notifyLevelLabel } from '@/lib/notify'
import { openDialog } from '@/stores/dialogStore'
import { openSettings } from '@/stores/navStore'
import { accountPrefs, usePrefsStore } from '@/stores/prefsStore'

/** The item/separator API shared by the Radix ContextMenu and DropdownMenu wrappers. */
interface MenuPrimitives {
  Item: React.ComponentType<{
    variant?: 'default' | 'destructive'
    onSelect?: (e: Event) => void
    /** Shows only in the mobile sheet. */
    hint?: React.ReactNode
    children?: React.ReactNode
  }>
  Separator: React.ComponentType
}

/**
 * A guild's actions (guild tile context menu and the guild header dropdown). One red row: Delete
 * for the owner, else Leave (an owner cannot leave without an ownership transfer). On the mobile
 * layout they are sheet rows (M43), and "Notification settings" shows the guild's level as a hint.
 */
export function GuildMenuItems({
  guildId,
  Item,
  Separator
}: MenuPrimitives & { guildId: string }): React.JSX.Element {
  const perms = usePermissions(guildId)
  const isOwner = useIsGuildOwner(guildId)
  const mobile = useLayout() === 'mobile'
  const level = usePrefsStore((s) => guildNotifyLevel(accountPrefs(s), guildId))
  const createChannel = (type: 'text' | 'category'): void =>
    openDialog({ kind: 'createChannel', guildId, type, parentId: null })

  return (
    <>
      <Item onSelect={() => openSettings({ kind: 'guild', guildId })}>
        <Settings /> Guild settings
      </Item>
      {has(perms, Permissions.CREATE_INSTANT_INVITE) && (
        <Item onSelect={() => openDialog({ kind: 'invite', guildId })}>
          <UserPlus /> Invite people
        </Item>
      )}
      {has(perms, Permissions.MANAGE_CHANNELS) && (
        <>
          <Separator />
          <Item onSelect={() => createChannel('text')}>
            {mobile ? <CirclePlus /> : <Plus />} Create channel
          </Item>
          <Item onSelect={() => createChannel('category')}>
            <FolderPlus /> Create category
          </Item>
        </>
      )}
      {has(perms, Permissions.MANAGE_EVENTS) && (
        <Item onSelect={() => openDialog({ kind: 'guildEvent', guildId, eventId: null })}>
          <CalendarHeart /> Create event
        </Item>
      )}
      <Item
        onSelect={() => openDialog({ kind: 'notifySettings', guildId })}
        hint={notifyLevelLabel(level)}
      >
        <Bell /> Notification settings
      </Item>
      <Separator />
      <Item variant="destructive" onSelect={() => openDialog({ kind: 'removeGuild', guildId })}>
        {isOwner ? <Trash2 /> : <LogOut />} {isOwner ? 'Delete guild' : 'Leave guild'}
      </Item>
    </>
  )
}
