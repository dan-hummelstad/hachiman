import {
  Download,
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
  Users,
  Wrench
} from 'lucide-react'
import { Permissions, has } from '@hachiman/client'
import { GuildInvitesTab } from '@/components/guild-settings-invites'
import { GuildMembersTab } from '@/components/guild-settings-members'
import { GuildRolesTab } from '@/components/guild-settings-roles'
import { DevicesPanel, useOwnDevices } from '@/components/security/devices-panel'
import { RecoverySection } from '@/components/security/recovery-panel'
import { SecurityLog } from '@/components/security/security-log'
import { ChannelOverviewPage } from '@/components/settings/channel-overview'
import { ChannelPermissionsPage, overrideCount } from '@/components/settings/channel-permissions'
import { GuildOverviewPage } from '@/components/settings/guild-overview'
import { AccountSection } from '@/components/settings/user/account'
import { AdvancedSection } from '@/components/settings/user/advanced'
import { AppearanceSection } from '@/components/settings/user/appearance'
import { UpdatesSection } from '@/components/settings/user/updates'
import { VoiceSection } from '@/components/settings/user/voice'
import { UserAvatar } from '@/components/shell/user-avatar'
import { GuildTile } from '@/components/ui/guild-tile'
import { useIsGuildOwner, usePermissions } from '@/hooks/use-hachiman'
import { ChannelIcon } from '@/lib/channel-icon'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import type { SettingsTarget } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'

/** One row of the settings list and its page. A hidden row (`visible: false`) is left out. */
export interface SettingsNavItem {
  id: string
  label: string
  icon: React.ReactNode
  /** A count chip on the right; 0 shows none. */
  count?: number
  /** Default true. */
  visible?: boolean
  /** Undefined while the guild or channel is not loaded. */
  page?: SettingsPageSpec
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
}

/**
 * The model of the settings `target` (null: none). Computed once in the shell and given to both
 * the settings list and the settings page. Every target hook runs, idle for the other kinds.
 */
export function useSettingsModel(target: SettingsTarget | null): SettingsModel | null {
  const user = useUserSettingsModel(target?.kind === 'user')
  const guild = useGuildSettingsModel(target?.kind === 'guild' ? target.guildId : null)
  const channel = useChannelSettingsModel(target?.kind === 'channel' ? target.channelId : null)
  if (!target) return null
  return target.kind === 'user' ? user : target.kind === 'guild' ? guild : channel
}

const NONE = <span />

function useUserSettingsModel(active: boolean): SettingsModel {
  const me = useUserStore((s) => s.me)
  // The security pages need the Worker. They hide while it is not ready.
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const desktop = usePlatform().platform === 'electron'
  const { devices } = useOwnDevices(active && encryption)
  const deviceCount = devices?.filter((d) => d.status !== 'revoked').length
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
      {
        items: [
          {
            id: 'account',
            label: 'My account',
            icon: <User />,
            page: {
              title: 'My account',
              description: 'How you appear to others, and the details that identify your account.',
              render: () => <AccountSection />
            }
          }
        ]
      },
      {
        heading: 'Security',
        items: [
          {
            id: 'devices',
            label: 'Devices',
            icon: <MonitorSmartphone />,
            count: deviceCount,
            visible: encryption,
            page: {
              title: 'Devices',
              description:
                'Each device has its own keys. Messages are encrypted for every device on this list.',
              render: () => <DevicesPanel variant="page" />
            }
          },
          {
            id: 'recovery',
            label: 'Recovery key',
            icon: <KeyRound />,
            visible: encryption,
            page: {
              title: 'Recovery key',
              description:
                'With your recovery key you can read your messages on a new device when no other device is signed in.',
              render: () => <RecoverySection />
            }
          },
          {
            id: 'securityLog',
            label: 'Security log',
            icon: <ScrollText />,
            visible: encryption,
            page: {
              title: 'Security log',
              description:
                'The server keeps a public log of every security key and device of each account. Your devices check that each change to your account came from one of your devices. If the server adds a device that you did not add, the check finds it.',
              render: () => <SecurityLog />
            }
          }
        ]
      },
      {
        heading: 'App',
        items: [
          {
            id: 'appearance',
            label: 'Appearance',
            icon: <Palette />,
            page: {
              title: 'Appearance',
              description: 'Pick a theme, how the sidebar shows and how dense messages are.',
              render: () => <AppearanceSection />
            }
          },
          {
            id: 'voice',
            label: 'Voice and audio',
            icon: <Headphones />,
            page: {
              title: 'Voice and audio',
              description: 'Your microphone, speakers and the sounds Hachiman plays.',
              render: () => <VoiceSection />
            }
          },
          // The web app updates on reload.
          {
            id: 'updates',
            label: 'Updates',
            icon: <Download />,
            visible: desktop,
            page: {
              title: 'Updates',
              description:
                'Hachiman checks for a new version when it starts and every 4 hours. A new version downloads in the background, then Hachiman asks to restart.',
              render: () => <UpdatesSection />
            }
          },
          {
            id: 'advanced',
            label: 'Advanced',
            icon: <Wrench />,
            page: {
              title: 'Advanced',
              description: 'Developer tools that clear the local data of this device.',
              render: () => <AdvancedSection />
            }
          }
        ]
      }
    ],
    danger: { label: 'Sign out', icon: <LogOut />, onClick: () => takusenService.signOut() }
  }
}

/** Each section only shows if the user holds its permission. */
function useGuildSettingsModel(guildId: string | null): SettingsModel {
  const guild = useGuildStore((s) => (guildId ? s.guilds.get(guildId) : undefined))
  const roleCount = useGuildStore((s) => (guildId ? (s.roles.get(guildId)?.size ?? 0) : 0))
  const memberCount = useGuildStore((s) => (guildId ? (s.members.get(guildId)?.size ?? 0) : 0))
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
          {
            id: 'overview',
            label: 'Overview',
            icon: <LayoutGrid />,
            visible: canManage,
            page: guild && {
              title: 'Overview',
              description: `How ${name} looks, where its voice runs, and what new members can read.`,
              render: () => <GuildOverviewPage guild={guild} />
            }
          },
          {
            id: 'roles',
            label: 'Roles',
            icon: <Shield />,
            count: roleCount,
            visible: has(perms, Permissions.MANAGE_ROLES),
            page: guild && {
              title: 'Roles',
              description:
                'Members take the colour of their highest role. Drag to change the order.',
              wide: true,
              render: () => <GuildRolesTab guildId={guild.id} />
            }
          },
          // Everyone can at least see the list and change their own nickname.
          {
            id: 'members',
            label: 'Members',
            icon: <Users />,
            count: memberCount,
            page: guild && {
              title: 'Members',
              description: members,
              wide: true,
              render: () => <GuildMembersTab guild={guild} />
            }
          },
          {
            id: 'invites',
            label: 'Invites',
            icon: <Link />,
            visible: canManage || has(perms, Permissions.CREATE_INSTANT_INVITE),
            page: guild && {
              title: 'Invites',
              description: `Links that let people join ${name}. Anyone with a link can join until it expires or runs out of uses.`,
              wide: true,
              render: () => <GuildInvitesTab guildId={guild.id} />
            }
          }
        ]
      }
    ],
    danger: {
      label: isOwner ? 'Delete guild' : 'Leave guild',
      icon: isOwner ? <Trash2 /> : <LogOut />,
      onClick: () => guildId && openDialog({ kind: 'removeGuild', guildId })
    }
  }
}

/** Rename and topic (MANAGE_CHANNELS), permission overwrites (MANAGE_ROLES). */
function useChannelSettingsModel(channelId: string | null): SettingsModel {
  const channel = useChannelStore((s) => (channelId ? s.channels.get(channelId) : undefined))
  const guildName = useGuildStore((s) =>
    channel?.guildId ? s.guilds.get(channel.guildId)?.name : undefined
  )
  const perms = usePermissions(channel?.guildId ?? null, channelId)
  const canManage = has(perms, Permissions.MANAGE_CHANNELS)
  const isCategory = channel?.type === 'category'
  const kind = isCategory ? 'category' : 'channel'
  const name = channel?.name ?? ''
  const inGuild = channel?.guildId != null ? channel : undefined
  const shown = isCategory || channel?.type === 'voice' ? name : `#${name}`
  return {
    label: isCategory ? 'Category settings' : 'Channel settings',
    crumb: shown,
    header: {
      icon: (
        <span className="bg-surface-raised text-text-secondary flex size-9 items-center justify-center">
          <ChannelIcon type={channel?.type ?? 'text'} className="size-5" />
        </span>
      ),
      name,
      subtitle: `${isCategory ? 'Category' : 'Channel'} settings${guildName ? ` · ${guildName}` : ''}`
    },
    groups: [
      {
        items: [
          {
            id: 'overview',
            label: 'Overview',
            icon: <SlidersHorizontal />,
            page: inGuild && {
              title: 'Overview',
              description: `How ${shown} looks to everyone${guildName ? ` in ${guildName}` : ''}.`,
              render: () => <ChannelOverviewPage channel={inGuild} editable={canManage} />
            }
          },
          {
            id: 'permissions',
            label: 'Permissions',
            icon: <Shield />,
            count: channel ? overrideCount(channel.permissionOverwrites) : 0,
            visible: has(perms, Permissions.MANAGE_ROLES),
            page: inGuild && {
              title: 'Permissions',
              description: `Overrides for this ${kind}. Allow and deny win over the guild-wide role; the middle setting keeps the role’s default.`,
              wide: true,
              render: () => (
                <ChannelPermissionsPage channel={inGuild} guildId={inGuild.guildId as string} />
              )
            }
          }
        ]
      }
    ],
    danger: canManage
      ? {
          label: isCategory ? 'Delete category' : 'Delete channel',
          icon: <Trash2 />,
          onClick: () => channelId && openDialog({ kind: 'deleteChannel', channelId })
        }
      : undefined
  }
}
