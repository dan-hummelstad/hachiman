import {
  Bell,
  CalendarHeart,
  FolderPlus,
  LogOut,
  Plus,
  Settings,
  Trash2,
  UserPlus
} from 'lucide-react'
import { Permissions, has } from '@hachiman/client'
import { useIsGuildOwner, usePermissions } from '@/hooks/use-hachiman'
import { openDialog } from '@/stores/dialogStore'
import { openSettings } from '@/stores/navStore'

/** The item/separator API shared by the Radix ContextMenu and DropdownMenu wrappers. */
interface MenuPrimitives {
  Item: React.ComponentType<{
    variant?: 'default' | 'destructive'
    onSelect?: (e: Event) => void
    children?: React.ReactNode
  }>
  Separator: React.ComponentType
}

/** A guild's actions (guild tile context menu and the guild header dropdown). */
export function GuildMenuItems({
  guildId,
  Item,
  Separator
}: MenuPrimitives & { guildId: string }): React.JSX.Element {
  const perms = usePermissions(guildId)
  const isOwner = useIsGuildOwner(guildId)
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
            <Plus /> Create channel
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
      <Item onSelect={() => openDialog({ kind: 'notifySettings', guildId })}>
        <Bell /> Notification settings
      </Item>
      <Separator />
      <Item variant="destructive" onSelect={() => openDialog({ kind: 'removeGuild', guildId })}>
        {isOwner ? <Trash2 /> : <LogOut />} {isOwner ? 'Delete guild' : 'Leave guild'}
      </Item>
    </>
  )
}
