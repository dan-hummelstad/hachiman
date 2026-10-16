import {
  AudioLines,
  Ban,
  Bell,
  Download,
  Headphones,
  Keyboard,
  KeyRound,
  LayoutGrid,
  Link,
  LogOut,
  MonitorSmartphone,
  Palette,
  ScrollText,
  Shield,
  Smile,
  SlidersHorizontal,
  Trash2,
  User,
  Users,
  Wrench
} from 'lucide-react'
import { Permissions, has } from '@hachiman/client'
import { GuildBansTab } from '@/components/guild-settings-bans'
import { GuildEmojisTab } from '@/components/guild-settings-emojis'
import { GuildInvitesTab } from '@/components/guild-settings-invites'
import { GuildMembersTab } from '@/components/guild-settings-members'
import { GuildRolesTab } from '@/components/guild-settings-roles'
import type { ListRowTile } from '@/components/mobile/list'
import { DevicesPanel } from '@/components/security/devices-panel'
import { useOwnDevices } from '@/components/security/use-own-devices'
import { RecoverySection } from '@/components/security/recovery-panel'
import { SecurityLog } from '@/components/security/security-log'
import { useActiveInviteCount } from '@/components/settings/use-guild-invites'
import { ChannelOverviewPage } from '@/components/settings/channel-overview'
import { ChannelPermissionsPage, overrideCount } from '@/components/settings/channel-permissions'
import { GuildOverviewPage } from '@/components/settings/guild-overview'
import { GuildSoundboardPage } from '@/components/settings/guild-soundboard'
import { AccountSection } from '@/components/settings/user/account'
import { AdvancedSection } from '@/components/settings/user/advanced'
import { AppearanceSection } from '@/components/settings/user/appearance'
import { CloseToTraySection } from '@/components/settings/user/tray'
import { KeybindsSection } from '@/components/settings/user/keybinds'
import {
  NotificationSettings,
  NotificationsSection
} from '@/components/settings/user/notifications'
import { PrivacySection } from '@/components/settings/user/privacy'
import { UpdatesSection } from '@/components/settings/user/updates'
import { VoiceSection } from '@/components/settings/user/voice'
import { UserAvatar } from '@/components/shell/user-avatar'
import { GuildTile } from '@/components/ui/guild-tile'
import { useIsGuildOwner, usePermissions } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { ChannelIcon } from '@/lib/channel-icon'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import type { SettingsTarget } from '@/stores/navStore'
import { usePrefsStore, type Theme } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'

/** One row of the settings list and its page. A hidden row (`visible: false`) is left out. */
export interface SettingsNavItem {
  id: string
  label: string
  icon: React.ReactNode
  /** A count chip on the right; 0 shows none. */
  count?: number
  /** Mobile list: short text at the end of the row ("Dark"). Without it the count shows there. */
  value?: string
  /** Mobile list: the colour of the row's icon tile (default accent). */
  tint?: ListRowTile
  /** Mobile list: a second line under the label. */
  detail?: string
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
  /** Mobile: the description shows as the intro paragraph on top of the screen (M25, M27). */
  intro?: boolean
  /** Mobile: the Nav Bar subtitle of the page's screen, in place of the model's. */
  navSubtitle?: string
  render: () => React.ReactNode
}

/** The red action set apart below the settings list. */
export interface SettingsDanger {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  /** Mobile: a second line under the label ("For everyone, with its message history"). */
  detail?: string
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
  danger?: SettingsDanger
  /**
   * The form on the mobile layout: a pushed list of rows (user M29, channel M48) or tabs on the
   * window (guild M52).
   */
  layout: 'list' | 'tabs'
  /** Mobile: the Nav Bar title of the first screen. Default `label`. */
  navTitle?: string
  /** Mobile: the Nav Bar subtitle of the first screen ("Night Owls · 12 members"). */
  navSubtitle?: string
  /**
   * Mobile user list: the status chip of the profile header opens this. Without it the chip only
   * shows the status.
   */
  onStatus?: () => void
}

/**
 * The model of the settings `target` (null: none). Computed once in the shell and given to both
 * the settings list and the settings page. Every target hook runs, idle for the other kinds.
 */
export function useSettingsModel(target: SettingsTarget | null): SettingsModel | null {
  const mobile = useLayout() === 'mobile'
  const user = useUserSettingsModel(target?.kind === 'user', mobile)
  const guild = useGuildSettingsModel(target?.kind === 'guild' ? target.guildId : null, mobile)
  const channel = useChannelSettingsModel(
    target?.kind === 'channel' ? target.channelId : null,
    mobile
  )
  if (!target) return null
  return target.kind === 'user' ? user : target.kind === 'guild' ? guild : channel
}

const NONE = <span />

/** The theme as the mobile Appearance row shows it. */
const THEME_VALUE: Record<Theme, string> = { dark: 'Dark', light: 'Light', system: 'System' }

/**
 * On the mobile layout: Privacy and safety (M34) and Notifications (M33), no Keybinds (a phone has
 * no keyboard shortcuts), Advanced as the last row of a Help group (the only reset path on a
 * phone), the status chip opens the status sheet, and Sign out asks first (M35).
 */
function useUserSettingsModel(active: boolean, mobile: boolean): SettingsModel {
  const me = useUserStore((s) => s.me)
  // The security pages need the Worker. They hide while it is not ready.
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const desktop = usePlatform().platform === 'electron'
  const theme = usePrefsStore((s) => s.theme)
  const { devices } = useOwnDevices(active && encryption)
  const deviceCount = devices?.filter((d) => d.status !== 'revoked').length
  const name = me?.username ?? 'You'
  const advanced: SettingsNavItem = {
    id: 'advanced',
    label: 'Advanced',
    icon: <Wrench />,
    tint: 'neutral',
    page: {
      title: 'Advanced',
      description: 'Developer tools that clear the local data of this device.',
      intro: true,
      render: () => <AdvancedSection />
    }
  }
  return {
    label: 'User settings',
    crumb: 'User settings',
    layout: 'list',
    navTitle: 'Settings',
    navSubtitle: 'Your account and this phone',
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
          },
          {
            id: 'privacy',
            label: 'Privacy and safety',
            icon: <Shield />,
            tint: 'thread',
            visible: mobile,
            page: {
              title: 'Privacy and safety',
              description: 'The people you blocked.',
              render: () => <PrivacySection />
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
              intro: true,
              navSubtitle:
                deviceCount === undefined
                  ? undefined
                  : `${deviceCount} ${deviceCount === 1 ? 'device holds' : 'devices hold'} your keys`,
              render: () => <DevicesPanel variant="page" />
            }
          },
          {
            id: 'recovery',
            label: 'Recovery key',
            icon: <KeyRound />,
            tint: 'event',
            visible: encryption,
            page: {
              title: 'Recovery key',
              description:
                'With your recovery key you can read your messages on a new device when no other device is signed in.',
              intro: true,
              navSubtitle: name,
              render: () => <RecoverySection />
            }
          },
          {
            id: 'securityLog',
            label: 'Security log',
            icon: <ScrollText />,
            tint: 'voice',
            visible: encryption,
            page: {
              title: 'Security log',
              description:
                'The server keeps a public log of every security key and device of each account. Your devices check that each change to your account came from one of your devices. If the server adds a device that you did not add, the check finds it.',
              intro: true,
              navSubtitle: name,
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
            value: THEME_VALUE[theme],
            tint: 'page',
            page: {
              title: 'Appearance',
              description: 'Pick a theme, how the sidebar shows and how dense messages are.',
              render: () => <AppearanceSection />
            }
          },
          {
            id: 'notifications',
            label: 'Notifications',
            icon: <Bell />,
            tint: 'activity',
            page: {
              title: 'Notifications',
              description: 'What notifies this device, and the level of each guild.',
              render: () => (mobile ? <NotificationsSection /> : <NotificationSettings />)
            }
          },
          {
            id: 'voice',
            label: 'Voice and audio',
            icon: <Headphones />,
            tint: 'voice',
            page: {
              title: 'Voice and audio',
              description: 'Your microphone, speakers and the sounds Hachiman plays.',
              render: () => <VoiceSection />
            }
          },
          {
            id: 'keybinds',
            label: 'Keybinds',
            icon: <Keyboard />,
            visible: !mobile,
            page: {
              title: 'Keybinds',
              description: 'Click a key to change it, then press the new keys. Esc cancels.',
              render: () => <KeybindsSection />
            }
          },
          // The web app has no tray and updates on reload.
          {
            id: 'updates',
            label: 'Desktop app',
            icon: <Download />,
            tint: 'neutral',
            visible: desktop,
            page: {
              title: 'Desktop app',
              description: 'What the close button does, and updates.',
              render: () => (
                <div className="grid gap-8">
                  <CloseToTraySection />
                  <UpdatesSection />
                </div>
              )
            }
          },
          ...(mobile ? [] : [advanced])
        ]
      },
      ...(mobile ? [{ heading: 'Help', items: [advanced] }] : [])
    ],
    danger: {
      label: 'Sign out',
      icon: <LogOut />,
      onClick: mobile ? () => openDialog({ kind: 'signOut' }) : () => takusenService.signOut()
    },
    onStatus: mobile ? () => openDialog({ kind: 'status' }) : undefined
  }
}

/**
 * Each section only shows if the user holds its permission. On the mobile layout the Invites tab
 * counts the active invites (M52, M55), so the invite list loads while guild settings are open.
 */
function useGuildSettingsModel(guildId: string | null, mobile: boolean): SettingsModel {
  const guild = useGuildStore((s) => (guildId ? s.guilds.get(guildId) : undefined))
  const roleCount = useGuildStore((s) => (guildId ? (s.roles.get(guildId)?.size ?? 0) : 0))
  const memberCount = useGuildStore((s) => (guildId ? (s.members.get(guildId)?.size ?? 0) : 0))
  const emojiCount = useGuildStore((s) => (guildId ? (s.emojis.get(guildId)?.length ?? 0) : 0))
  const isOwner = useIsGuildOwner(guildId)
  const perms = usePermissions(guildId)
  const canManage = has(perms, Permissions.MANAGE_GUILD)
  const inviteCount = useActiveInviteCount(mobile && canManage ? guildId : null)
  const name = guild?.name ?? 'Guild'
  const members = `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
  return {
    label: 'Guild settings',
    crumb: name,
    layout: 'tabs',
    navSubtitle: `${name} · ${members}`,
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
          {
            id: 'emoji',
            label: 'Emoji',
            icon: <Smile />,
            count: emojiCount,
            visible: has(perms, Permissions.MANAGE_EXPRESSIONS),
            page: guild && {
              title: 'Emoji',
              description: `Custom emojis that members of ${name} can use in messages and reactions, here and in other guilds.`,
              wide: true,
              render: () => <GuildEmojisTab guildId={guild.id} />
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
            count: inviteCount,
            visible: canManage || has(perms, Permissions.CREATE_INSTANT_INVITE),
            page: guild && {
              title: 'Invites',
              description: `Links that let people join ${name}. Anyone with a link can join until it expires or runs out of uses.`,
              intro: true,
              wide: true,
              render: () => <GuildInvitesTab guildId={guild.id} />
            }
          },
          // Everyone can see and preview the sounds; MANAGE_EXPRESSIONS uploads and deletes.
          {
            id: 'soundboard',
            label: 'Soundboard',
            icon: <AudioLines />,
            page: guild && {
              title: 'Soundboard',
              description: `Short sounds that members of ${name} can play in voice channels.`,
              render: () => <GuildSoundboardPage guildId={guild.id} />
            }
          },
          {
            id: 'bans',
            label: 'Bans',
            icon: <Ban />,
            visible: has(perms, Permissions.BAN_MEMBERS),
            page: guild && {
              title: 'Bans',
              description: `People who cannot join ${name} with an invite. Unban to let them join again.`,
              wide: true,
              render: () => <GuildBansTab guildId={guild.id} />
            }
          }
        ]
      }
    ],
    danger: {
      label: isOwner ? 'Delete guild' : 'Leave guild',
      icon: isOwner ? <Trash2 /> : <LogOut />,
      detail: isOwner
        ? `${memberCount > 1 ? `For all ${members}. ` : ''}It can’t be undone.`
        : 'To come back, you need an invite.',
      onClick: () => guildId && openDialog({ kind: 'removeGuild', guildId })
    }
  }
}

/**
 * Rename and topic (MANAGE_CHANNELS), permission overwrites (MANAGE_ROLES). On the mobile layout
 * the overview shows on the first screen and Permissions is a row under ACCESS (M48).
 */
function useChannelSettingsModel(channelId: string | null, mobile: boolean): SettingsModel {
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
  const overview: SettingsNavItem = {
    id: 'overview',
    label: 'Overview',
    icon: <SlidersHorizontal />,
    page: inGuild && {
      title: 'Overview',
      description: `How ${shown} looks to everyone${guildName ? ` in ${guildName}` : ''}.`,
      render: () => <ChannelOverviewPage channel={inGuild} editable={canManage} />
    }
  }
  const permissions: SettingsNavItem = {
    id: 'permissions',
    label: 'Permissions',
    icon: <Shield />,
    count: channel ? overrideCount(channel.permissionOverwrites) : 0,
    detail: isCategory
      ? `Overrides for ${shown}`
      : channel?.type === 'voice'
        ? `Who can see and join ${shown}`
        : `Who can see and post in ${shown}`,
    visible: has(perms, Permissions.MANAGE_ROLES),
    page: inGuild && {
      title: 'Permissions',
      description: `Overrides for this ${kind}. Allow and deny win over the guild-wide role; the middle setting keeps the role’s default.`,
      wide: true,
      render: () => <ChannelPermissionsPage channel={inGuild} guildId={inGuild.guildId as string} />
    }
  }
  return {
    label: isCategory ? 'Category settings' : 'Channel settings',
    crumb: shown,
    layout: 'list',
    navSubtitle: guildName ? `${shown} · ${guildName}` : shown,
    header: {
      icon: (
        <span className="bg-surface-raised text-text-secondary flex size-9 items-center justify-center">
          <ChannelIcon type={channel?.type ?? 'text'} className="size-5" />
        </span>
      ),
      name,
      subtitle: `${isCategory ? 'Category' : 'Channel'} settings${guildName ? ` · ${guildName}` : ''}`
    },
    groups: mobile
      ? [{ items: [overview] }, { heading: 'Access', items: [permissions] }]
      : [{ items: [overview, permissions] }],
    danger: canManage
      ? {
          label: isCategory ? 'Delete category' : 'Delete channel',
          icon: <Trash2 />,
          detail:
            channel?.type === 'text' ? 'For everyone, with its message history' : 'For everyone',
          onClick: () => channelId && openDialog({ kind: 'deleteChannel', channelId })
        }
      : undefined
  }
}
