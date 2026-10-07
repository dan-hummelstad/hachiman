import {
  Download,
  Hash,
  Headphones,
  KeyRound,
  LayoutGrid,
  Link,
  LogOut,
  MonitorSmartphone,
  Palette,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Trash2,
  User,
  Users
} from 'lucide-react'
import { Permissions, has } from '@hachiman/client'
import { GuildInvitesTab } from '@/components/guild-settings-invites'
import { GuildMembersTab } from '@/components/guild-settings-members'
import { GuildRolesTab } from '@/components/guild-settings-roles'
import { DevicesPanel } from '@/components/security/devices-panel'
import { RecoverySection } from '@/components/security/recovery-panel'
import { SecurityLog } from '@/components/security/security-log'
import { ChannelOverviewPage } from '@/components/settings/channel-overview'
import { ChannelPermissionsPage, overrideCount } from '@/components/settings/channel-permissions'
import { GuildOverviewPage } from '@/components/settings/guild-overview'
import { AccountSection } from '@/components/settings/user/account'
import { AppearanceSection } from '@/components/settings/user/appearance'
import { UpdatesSection } from '@/components/settings/user/updates'
import { VoiceSection } from '@/components/settings/user/voice'
import { UserAvatar } from '@/components/shell/user-avatar'
import { GuildTile } from '@/components/ui/guild-tile'
import { useIsGuildOwner, usePermissions } from '@/hooks/use-hachiman'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

/** What the settings set up. The shell keeps it (with the section) in its settings mode. */
export type SettingsTarget =
  { kind: 'user' } | { kind: 'guild'; guildId: string } | { kind: 'channel'; channelId: string }

export type UserSettingsSection =
  'account' | 'devices' | 'recovery' | 'securityLog' | 'appearance' | 'voice' | 'updates'
export type GuildSettingsSection = 'overview' | 'roles' | 'members' | 'invites'
export type ChannelSettingsSection = 'overview' | 'permissions'

/** One row of the settings list. A hidden row (`visible: false`) is left out. */
export interface SettingsNavItem {
  id: string
  label: string
  icon: React.ReactNode
  /** A count chip on the right; 0 shows none. */
  count?: number
  /** Default true. */
  visible?: boolean
}

export interface SettingsNavGroup {
  /** The group label (SECURITY, APP). The first group of user settings has none. */
  heading?: string
  items: SettingsNavItem[]
}

export interface SettingsPageSpec {
  title: string
  description?: React.ReactNode
  /** Two-pane pages (roles, permissions, tables) take a wider column. */
  wide?: boolean
  render: () => React.ReactNode
}

/** Everything the settings list and the settings page show for one target. */
export interface SettingsModel {
  /** Accessible name of the list, e.g. "Guild settings". */
  label: string
  /** The breadcrumb root: "User settings", the guild name, "#general". */
  crumb: string
  header: { icon: React.ReactNode; name: string; subtitle: string }
  groups: SettingsNavGroup[]
  /** The red action set apart below the list. */
  danger?: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }
  pages: Partial<Record<string, SettingsPageSpec>>
}

export const isVisible = (s: SettingsNavItem): boolean => s.visible !== false

/** `picked` when the list shows it, else the first visible section. */
export function resolveSection(model: SettingsModel, picked: string | null): string {
  const visible = model.groups.flatMap((g) => g.items).filter(isVisible)
  return visible.some((s) => s.id === picked) ? (picked as string) : (visible[0]?.id ?? '')
}

const NONE = <span />

export function useUserSettingsModel(): SettingsModel {
  const me = useUserStore((s) => s.me)
  // The security pages need the Worker. They hide while it is not ready.
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const desktop = usePlatform().platform === 'electron'
  const name = me?.username ?? 'You'
  return {
    label: 'User settings',
    crumb: 'User settings',
    header: {
      icon: <UserAvatar name={name} avatar={me?.avatar} size={36} />,
      name,
      subtitle: 'User settings'
    },
    groups: [
      { items: [{ id: 'account', label: 'My account', icon: <User /> }] },
      {
        heading: 'Security',
        items: [
          { id: 'devices', label: 'Devices', icon: <MonitorSmartphone />, visible: encryption },
          { id: 'recovery', label: 'Recovery key', icon: <KeyRound />, visible: encryption },
          { id: 'securityLog', label: 'Security log', icon: <ScrollText />, visible: encryption }
        ]
      },
      {
        heading: 'App',
        items: [
          { id: 'appearance', label: 'Appearance', icon: <Palette /> },
          { id: 'voice', label: 'Voice and audio', icon: <Headphones /> },
          // The web app updates on reload.
          { id: 'updates', label: 'Updates', icon: <Download />, visible: desktop }
        ]
      }
    ],
    danger: { label: 'Sign out', icon: <LogOut />, onClick: () => takusenService.signOut() },
    pages: {
      account: {
        title: 'My account',
        description: 'How you appear to others, and the details that identify your account.',
        render: () => <AccountSection />
      },
      devices: {
        title: 'Devices',
        description:
          'Each device has its own keys. Messages are encrypted for every device on this list.',
        render: () => <DevicesPanel variant="page" />
      },
      recovery: {
        title: 'Recovery key',
        description:
          'With your recovery key you can read your messages on a new device when no other device is signed in.',
        render: () => <RecoverySection />
      },
      securityLog: {
        title: 'Security log',
        description:
          'The server keeps a public log of every security key and device of each account. Your devices check that each change to your account came from one of your devices. If the server adds a device that you did not add, the check finds it.',
        render: () => <SecurityLog />
      },
      appearance: {
        title: 'Appearance',
        description: 'Pick a theme and how dense messages are.',
        render: () => <AppearanceSection />
      },
      voice: {
        title: 'Voice and audio',
        description: 'Your microphone, speakers and the sounds Hachiman plays.',
        render: () => <VoiceSection />
      },
      updates: {
        title: 'Updates',
        description:
          'Hachiman checks for a new version when it starts and every 4 hours. A new version downloads in the background, then Hachiman asks to restart.',
        render: () => <UpdatesSection />
      }
    }
  }
}

/** Each section only shows if the user holds its permission. */
export function useGuildSettingsModel(guildId: string): SettingsModel {
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const roleCount = useGuildStore((s) => s.roles.get(guildId)?.size ?? 0)
  const memberCount = useGuildStore((s) => s.members.get(guildId)?.size ?? 0)
  const isOwner = useIsGuildOwner(guildId)
  const perms = usePermissions(guildId)
  const canManage = has(perms, Permissions.MANAGE_GUILD)
  const name = guild?.name ?? 'Guild'
  const members = `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
  return {
    label: 'Guild settings',
    crumb: name,
    header: {
      icon: guild ? <GuildTile guild={guild} className="size-9 text-[13px]" /> : NONE,
      name,
      subtitle: `Guild settings · ${members}`
    },
    groups: [
      {
        items: [
          { id: 'overview', label: 'Overview', icon: <LayoutGrid />, visible: canManage },
          {
            id: 'roles',
            label: 'Roles',
            icon: <Shield />,
            count: roleCount,
            visible: has(perms, Permissions.MANAGE_ROLES)
          },
          // Everyone can at least see the list and change their own nickname.
          { id: 'members', label: 'Members', icon: <Users />, count: memberCount },
          {
            id: 'invites',
            label: 'Invites',
            icon: <Link />,
            visible: canManage || has(perms, Permissions.CREATE_INSTANT_INVITE)
          }
        ]
      }
    ],
    danger: {
      label: isOwner ? 'Delete guild' : 'Leave guild',
      icon: isOwner ? <Trash2 /> : <LogOut />,
      onClick: () => openDialog({ kind: 'removeGuild', guildId })
    },
    pages: guild
      ? {
          overview: {
            title: 'Overview',
            description: `How ${name} looks, where its voice runs, and what new members can read.`,
            render: () => <GuildOverviewPage guild={guild} />
          },
          roles: {
            title: 'Roles',
            description: 'Members take the colour of their highest role. Drag to change the order.',
            wide: true,
            render: () => <GuildRolesTab guildId={guildId} />
          },
          members: {
            title: 'Members',
            description: members,
            wide: true,
            render: () => <GuildMembersTab guild={guild} />
          },
          invites: {
            title: 'Invites',
            description: `Links that let people join ${name}. Anyone with a link can join until it expires or runs out of uses.`,
            wide: true,
            render: () => <GuildInvitesTab guildId={guildId} />
          }
        }
      : {}
  }
}

/** Rename and topic (MANAGE_CHANNELS), permission overwrites (MANAGE_ROLES). */
export function useChannelSettingsModel(channelId: string): SettingsModel {
  const channel = useChannelStore((s) => s.channels.get(channelId))
  const guildName = useGuildStore((s) =>
    channel?.guildId ? s.guilds.get(channel.guildId)?.name : undefined
  )
  const perms = usePermissions(channel?.guildId ?? null, channelId)
  const canManage = has(perms, Permissions.MANAGE_CHANNELS)
  const isCategory = channel?.type === 'category'
  const kind = isCategory ? 'category' : 'channel'
  const name = channel?.name ?? ''
  const shown = isCategory ? name : `#${name}`
  return {
    label: isCategory ? 'Category settings' : 'Channel settings',
    crumb: shown,
    header: {
      icon: (
        <span className="rounded-control bg-surface-raised text-text-secondary flex size-9 items-center justify-center">
          <Hash className="size-5" />
        </span>
      ),
      name,
      subtitle: `${isCategory ? 'Category' : 'Channel'} settings${guildName ? ` · ${guildName}` : ''}`
    },
    groups: [
      {
        items: [
          { id: 'overview', label: 'Overview', icon: <SlidersHorizontal /> },
          {
            id: 'permissions',
            label: 'Permissions',
            icon: <Shield />,
            count: channel ? overrideCount(channel.permissionOverwrites) : 0,
            visible: has(perms, Permissions.MANAGE_ROLES)
          }
        ]
      }
    ],
    danger: canManage
      ? {
          label: isCategory ? 'Delete category' : 'Delete channel',
          icon: <Trash2 />,
          onClick: () => openDialog({ kind: 'deleteChannel', channelId })
        }
      : undefined,
    pages:
      channel?.guildId != null
        ? {
            overview: {
              title: 'Overview',
              description: `How ${shown} looks to everyone${guildName ? ` in ${guildName}` : ''}.`,
              render: () => <ChannelOverviewPage channel={channel} editable={canManage} />
            },
            permissions: {
              title: 'Permissions',
              description: `Overrides for this ${kind}. Allow and deny win over the guild-wide role; the middle setting keeps the role’s default.`,
              wide: true,
              render: () => (
                <ChannelPermissionsPage channel={channel} guildId={channel.guildId as string} />
              )
            }
          }
        : {}
  }
}
