import { useMemo, useState } from 'react'
import { AtSign, Inbox, Moon } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import { useDeviceNoun } from '@/components/security/onboarding-steps'
import {
  ChoiceCards,
  MobileCap,
  MobileCard,
  MobileNote,
  RadioRows,
  SettingsCap,
  SettingsRule,
  SpaceRow,
  ToggleRow
} from '@/components/settings/user/rows'
import { UnreadMark } from '@/components/ui/unread-mark'
import { guildNotifyLevel, notifyLevelLabel, type NotifyKind, type NotifyPrefs } from '@/lib/notify'
import { orderedIds } from '@/lib/sidebar-tiles'
import { disablePush, enablePush, notifyKinds, setNotifyKind } from '@/services/PushService'
import { usePlatform } from '@/shared/PlatformContext'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useGuildOrder, useNotifyPrefs, usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { GuildTile } from '@/components/ui/guild-tile'
import { ChevronRight } from 'lucide-react'

/** The value of a guild row: "Muted", else the guild's level ("Mentions"). */
function guildNotifyValue(prefs: NotifyPrefs, guildId: string): string {
  return prefs.muted.includes(guildId)
    ? 'Muted'
    : notifyLevelLabel(guildNotifyLevel(prefs, guildId))
}

const KIND_LABELS: Record<NotifyKind, string> = {
  dm: 'Direct messages',
  mention: 'Mentions',
  channel: 'Other channel messages',
  poke: 'Pokes',
  ring: 'Incoming calls'
}

const KIND_HINTS: Partial<Record<NotifyKind, string>> = {
  channel: 'Channels set to All messages'
}

export type NotifyMode = 'everything' | 'mentions' | 'nothing'

const MODE_LABEL: Record<NotifyMode, string> = {
  everything: 'EVERYTHING',
  mentions: 'MENTIONS ONLY',
  nothing: 'NOTHING'
}

/** The mono caps word of a mode, for the value of the mobile settings row. */
export const notifyModeLabel = (mode: NotifyMode): string => MODE_LABEL[mode]

/** The mode of this install, for the settings list. */
export function useNotifyMode(): NotifyMode {
  const on = usePrefsStore((s) => s.pushEnabled)
  const disabled = usePrefsStore((s) => s.disabledNotifications)
  return !on ? 'nothing' : disabled.includes('channel') ? 'mentions' : 'everything'
}

/**
 * The mode, the master switch and the kind switches of this install (PushService), for both
 * layouts. `error`: why a switch stayed off, for example a refused OS permission.
 */
function useNotifySettings(): {
  on: boolean
  mode: NotifyMode
  disabled: readonly NotifyKind[]
  kinds: readonly NotifyKind[]
  busy: boolean
  error: string | null
  /** What reaches this device, and while what. */
  hint: string
  setMode: (mode: NotifyMode) => void
  toggleKind: (kind: NotifyKind, on: boolean) => void
} {
  const platform = usePlatform()
  const noun = useDeviceNoun()
  const on = usePrefsStore((s) => s.pushEnabled)
  const disabled = usePrefsStore((s) => s.disabledNotifications)
  const mode = useNotifyMode()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const where =
    platform.platform === 'browser'
      ? 'the site settings of your browser'
      : platform.platform === 'ios'
        ? 'the Settings app'
        : 'your system settings'
  const blocked = `Notifications are blocked. Allow them for Hachiman in ${where}, then try again.`
  // The user can take the OS permission back after the switch went on.
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied'
  const kinds = notifyKinds()

  const run = (change: () => Promise<boolean>): void => {
    setBusy(true)
    setError(null)
    change()
      .then((ok) => {
        if (!ok) setError(blocked)
      })
      .catch((e: unknown) => {
        console.error('[push] switch failed', e)
        setError('Could not change notifications. Try again.')
      })
      .finally(() => setBusy(false))
  }

  const hint =
    platform.pushSubscribe === null
      ? 'While Hachiman runs in the background or the tray.'
      : `Direct messages and mentions also notify this ${noun} while Hachiman is closed. The sender and the text stay end-to-end encrypted: only this ${noun} can read them.`

  return {
    on,
    mode,
    disabled,
    kinds,
    busy,
    error: error ?? (on && denied ? blocked : null),
    hint,
    setMode: (next) =>
      run(async () => {
        if (next === 'nothing') {
          await disablePush()
          return true
        }
        if (!on && !(await enablePush())) return false
        return kinds.includes('channel') ? setNotifyKind('channel', next === 'everything') : true
      }),
    toggleKind: (kind, next) => run(() => setNotifyKind(kind, next))
  }
}

/** The kinds that the mode does not cover: one switch each, off while push is off. */
function DeliveryRows({ n }: { n: ReturnType<typeof useNotifySettings> }): React.JSX.Element[] {
  return n.kinds
    .filter((kind) => kind !== 'channel')
    .map((kind) => (
      <ToggleRow
        key={kind}
        title={KIND_LABELS[kind]}
        hint={KIND_HINTS[kind]}
        checked={!n.disabled.includes(kind)}
        disabled={!n.on || n.busy}
        onChange={(v) => n.toggleKind(kind, v)}
      />
    ))
}

/** A guild with the level of its notifications; a tap opens the guild's notification sheet. */
function useGuildList(): { guilds: Guild[]; members: Map<string, Map<string, unknown>> } {
  const all = useGuildStore((s) => s.guilds)
  const members = useGuildStore((s) => s.members)
  const order = useGuildOrder()
  const guilds = useMemo(
    () =>
      orderedIds([...all.keys()], order)
        .map((id) => all.get(id))
        .filter((g): g is Guild => g !== undefined),
    [all, order]
  )
  return { guilds, members }
}

/** Desktop: what reaches you, what it looks like, each space, then the delivery switches. */
export function NotificationSettings(): React.JSX.Element {
  const n = useNotifySettings()
  const prefs = useNotifyPrefs()
  const me = useUserStore((s) => s.me)
  const { guilds, members } = useGuildList()
  const options = [
    ...(n.kinds.includes('channel')
      ? [
          {
            value: 'everything' as const,
            title: 'Everything',
            sub: 'Every message in every channel you follow.',
            icon: <Inbox />
          }
        ]
      : []),
    {
      value: 'mentions' as const,
      title: 'Mentions & replies',
      sub: 'When someone names you, answers you, or posts @here.',
      icon: <AtSign />
    },
    {
      value: 'nothing' as const,
      title: 'Nothing',
      sub: 'Counts only. Hachiman never raises a notification.',
      icon: <Moon />
    }
  ]
  return (
    <div>
      <SettingsCap>What reaches you</SettingsCap>
      <div className="mt-2">
        <ChoiceCards
          label="What reaches you"
          value={n.mode}
          options={options}
          onChange={n.setMode}
          disabled={n.busy}
        />
      </div>
      <p role={n.error ? 'alert' : undefined} className="text-text-tertiary mt-2.5 text-[12.5px]">
        {n.error ?? n.hint}
      </p>
      <SettingsRule />
      <SettingsCap>What an interruption looks like</SettingsCap>
      <div className="mt-2 flex gap-6">
        <div
          aria-hidden
          className="rounded-r-control border-you bg-surface-raised flex w-[440px] shrink-0 items-center gap-3 border-l-2 p-3"
        >
          <span className="bg-avatar-2 text-text-secondary flex size-[30px] shrink-0 items-center justify-center rounded-[8px] font-mono text-[11px]">
            S
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-text-primary text-[13px] font-semibold">Someone</span>
              <span className="cap-sm">#GENERAL</span>
            </span>
            <span className="text-text-secondary block truncate text-[12.5px]">
              @{me?.username ?? 'you'} — can you take a look tonight?
            </span>
          </span>
          <UnreadMark badge={{ mentions: 1, unread: false }} count aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-text-primary text-[13.5px] font-semibold">One mark, one meaning</p>
          <p className="text-text-tertiary mt-1 text-[12.5px] leading-[19px]">
            The bar on its left edge and the count are the same vermilion the channel wears in the
            sidebar. Nothing else here is coloured. Read it and both marks go.
          </p>
        </div>
      </div>
      {guilds.length > 0 && (
        <>
          <SettingsRule />
          <SettingsCap>Per space</SettingsCap>
          <div className="mt-2">
            {guilds.map((g) => (
              <SpaceRow
                key={g.id}
                guild={g}
                memberCount={members.get(g.id)?.size}
                value={guildNotifyValue(prefs, g.id)}
                onClick={() => openDialog({ kind: 'notifySettings', guildId: g.id })}
              />
            ))}
          </div>
        </>
      )}
      <SettingsRule />
      <SettingsCap>Delivery</SettingsCap>
      <div className="mt-1.5">
        <DeliveryRows n={n} />
      </div>
      <p className="text-text-tertiary mt-2 text-[12.5px]">
        The level of each space and channel (its notification menu) chooses which messages ping.
      </p>
    </div>
  )
}

/**
 * User settings -> Notifications on the mobile layout: what buzzes this phone, the kind switches,
 * then one row per space, in my guild order, with its level or "Muted". A tap opens the space's
 * notification settings as a sheet. The sender and text of a push are sealed to this device
 * (§12.22): Takusen cannot read them.
 */
export function NotificationsSection(): React.JSX.Element {
  const n = useNotifySettings()
  const prefs = useNotifyPrefs()
  const { guilds } = useGuildList()
  const options = [
    ...(n.kinds.includes('channel')
      ? [
          {
            value: 'everything' as const,
            title: 'Everything',
            hint: 'Every message in every space you are in.'
          }
        ]
      : []),
    {
      value: 'mentions' as const,
      title: 'Only what is waiting on you',
      hint: 'Mentions, replies, direct messages, and calls you were invited to.'
    },
    {
      value: 'nothing' as const,
      title: 'Nothing',
      hint: 'The app still counts, it just stays quiet.'
    }
  ]
  return (
    <div className="grid gap-[18px]">
      <section className="flex flex-col gap-1.5">
        <MobileCap>Buzz my phone for</MobileCap>
        <RadioRows
          label="Buzz my phone for"
          value={n.mode}
          options={options}
          onChange={n.setMode}
          disabled={n.busy}
        />
      </section>
      <section className="flex flex-col gap-1.5">
        <MobileCap>Also</MobileCap>
        <MobileCard>
          <DeliveryRows n={n} />
        </MobileCard>
      </section>
      <section className="flex flex-col gap-1.5">
        <MobileCap>Spaces</MobileCap>
        {guilds.length > 0 ? (
          <MobileCard>
            {guilds.map((g) => (
              <GuildRow key={g.id} guild={g} value={guildNotifyValue(prefs, g.id)} />
            ))}
          </MobileCard>
        ) : (
          <p className="text-text-tertiary px-1 py-6 text-center text-sm">
            Join a guild to choose its notifications.
          </p>
        )}
        <p role={n.error ? 'alert' : undefined} className="contents">
          <MobileNote>{n.error ?? n.hint}</MobileNote>
        </p>
      </section>
    </div>
  )
}

/**
 * A guild as a List Row (46): its tile, the name, the level and a chevron. ListRow draws a
 * square tile, so the row draws its own.
 */
function GuildRow({ guild, value }: { guild: Guild; value: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => openDialog({ kind: 'notifySettings', guildId: guild.id })}
      className="active:bg-surface-hover focus-visible:outline-line-focus flex min-h-[46px] w-full items-center gap-3 py-1.5 pr-3.5 pl-3 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <GuildTile guild={guild} className="size-[30px] rounded-[7px] text-[12px]" />
      <span className="text-text-primary min-w-0 flex-1 truncate text-[15px] leading-[18px] font-medium">
        {guild.name}
      </span>
      <span className="text-text-tertiary shrink-0 text-[13px] leading-4">{value}</span>
      <ChevronRight aria-hidden className="text-text-disabled size-[17px] shrink-0" />
    </button>
  )
}
