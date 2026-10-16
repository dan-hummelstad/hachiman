import { useId, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { useDeviceNoun } from '@/components/security/onboarding-steps'
import { SectionHeading } from '@/components/ui/field'
import { GuildTile } from '@/components/ui/guild-tile'
import { Switch } from '@/components/ui/switch'
import { guildNotifyLevel, notifyLevelLabel, type NotifyKind, type NotifyPrefs } from '@/lib/notify'
import { orderedIds } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'
import { disablePush, enablePush, notifyKinds, setNotifyKind } from '@/services/PushService'
import { usePlatform } from '@/shared/PlatformContext'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useGuildOrder, useNotifyPrefs, usePrefsStore } from '@/stores/prefsStore'

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

/**
 * The master switch and the kind switches of this install (PushService), for both layouts.
 * `error`: why a switch stayed off, for example a refused OS permission.
 */
function useNotifySettings(): {
  on: boolean
  disabled: readonly NotifyKind[]
  kinds: readonly NotifyKind[]
  busy: boolean
  error: string | null
  /** What reaches this device, and while what. */
  hint: string
  toggle: (on: boolean) => void
  toggleKind: (kind: NotifyKind, on: boolean) => void
} {
  const platform = usePlatform()
  const noun = useDeviceNoun()
  const on = usePrefsStore((s) => s.pushEnabled)
  const disabled = usePrefsStore((s) => s.disabledNotifications)
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
      : `Direct messages also notify this ${noun} while Hachiman is closed, with no name and no text: messages are end-to-end encrypted.`

  return {
    on,
    disabled,
    kinds: notifyKinds(),
    busy,
    error: error ?? (on && denied ? blocked : null),
    hint,
    toggle: (next) => run(() => (next ? enablePush() : disablePush().then(() => true))),
    toggleKind: (kind, next) => run(() => setNotifyKind(kind, next))
  }
}

/** Desktop: the master switch, then one switch per kind, as the Sounds section. */
export function NotificationSettings(): React.JSX.Element {
  const n = useNotifySettings()
  const id = useId()
  return (
    <section className="grid gap-3">
      <SectionHeading className="mb-0">Notifications</SectionHeading>
      <div className="flex items-center gap-3">
        <Switch id={`${id}-all`} checked={n.on} disabled={n.busy} onCheckedChange={n.toggle} />
        <label htmlFor={`${id}-all`} className="text-label cursor-pointer">
          Show notifications
        </label>
      </div>
      <p role={n.error ? 'alert' : undefined} className="text-meta text-text-tertiary">
        {n.error ?? n.hint}
      </p>
      <ul className="grid max-w-md gap-y-0.5">
        {n.kinds.map((kind) => {
          const kindOn = !n.disabled.includes(kind)
          return (
            <li
              key={kind}
              className={cn(
                'flex h-9 items-center gap-2',
                (!n.on || !kindOn) && 'text-text-tertiary'
              )}
            >
              <label
                htmlFor={`${id}-${kind}`}
                className="text-label flex min-w-0 flex-1 items-baseline gap-2 font-medium"
              >
                <span className="truncate">{KIND_LABELS[kind]}</span>
                {KIND_HINTS[kind] && (
                  <span className="text-meta text-text-tertiary truncate">{KIND_HINTS[kind]}</span>
                )}
              </label>
              <Switch
                id={`${id}-${kind}`}
                checked={kindOn}
                disabled={!n.on || n.busy}
                onCheckedChange={(v) => n.toggleKind(kind, v)}
              />
            </li>
          )
        })}
      </ul>
      <p className="text-meta text-text-tertiary">
        The level of each guild and channel (its notification menu) chooses which messages ping.
      </p>
    </section>
  )
}

/**
 * User settings → Notifications on the mobile layout (M33): the switches of this device, then
 * GUILD OVERRIDES: one row per guild, in my guild order, with its level or "Muted". A tap opens
 * the guild's notification settings as a sheet. A push names no sender and no text: Takusen
 * cannot read them. Lock screen previews and quiet hours come later (spec §5).
 */
export function NotificationsSection(): React.JSX.Element {
  const guilds = useGuildStore((s) => s.guilds)
  const order = useGuildOrder()
  const prefs = useNotifyPrefs()
  const labelId = useId()
  const list = useMemo(
    () =>
      orderedIds([...guilds.keys()], order)
        .map((id) => guilds.get(id))
        .filter((g): g is Guild => g !== undefined),
    [guilds, order]
  )

  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <NotifyRows />
      <SectionLabel id={labelId}>Guild overrides</SectionLabel>
      {list.length > 0 ? (
        <ListGroup>
          {list.map((g) => (
            <GuildRow key={g.id} guild={g} value={guildNotifyValue(prefs, g.id)} />
          ))}
        </ListGroup>
      ) : (
        <p className="text-text-tertiary px-1 py-6 text-center text-sm">
          Join a guild to choose its notifications.
        </p>
      )}
      <p className="text-text-tertiary px-1 pt-1 text-[12.5px] leading-[18px] font-medium">
        These choose what counts as unread, what plays a sound and what notifies.
      </p>
    </section>
  )
}

/** Mobile: the master switch as a 50 row and one 44 row per kind, with a line under them. */
function NotifyRows(): React.JSX.Element {
  const n = useNotifySettings()
  const noun = useDeviceNoun()
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5 pb-3">
      <SectionLabel id={`${id}-label`}>Push notifications</SectionLabel>
      <ListGroup>
        <div className="flex min-h-[50px] items-center gap-3 px-3.5">
          <label
            htmlFor={`${id}-all`}
            className="text-text-primary flex flex-1 cursor-pointer items-center self-stretch text-[15px] leading-[18px] font-bold"
          >
            Notify this {noun}
          </label>
          <Switch
            size="touch"
            id={`${id}-all`}
            checked={n.on}
            disabled={n.busy}
            onCheckedChange={n.toggle}
          />
        </div>
        {n.kinds.map((kind) => (
          <div key={kind} className="flex min-h-11 items-center gap-2.5 px-3.5">
            <label
              htmlFor={`${id}-${kind}`}
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-1.5 self-stretch py-1.5 text-[15px] leading-[18px] font-semibold',
                n.on ? 'text-text-primary' : 'text-text-tertiary'
              )}
            >
              {KIND_LABELS[kind]}
              {KIND_HINTS[kind] && (
                <span className="text-text-tertiary text-[12.5px] font-medium">
                  {KIND_HINTS[kind]}
                </span>
              )}
            </label>
            <Switch
              size="touch"
              id={`${id}-${kind}`}
              checked={!n.disabled.includes(kind)}
              disabled={!n.on || n.busy}
              onCheckedChange={(v) => n.toggleKind(kind, v)}
            />
          </div>
        ))}
      </ListGroup>
      <p
        role={n.error ? 'alert' : undefined}
        className="text-text-tertiary px-1 text-[12.5px] leading-[18px] font-medium"
      >
        {n.error ?? n.hint}
      </p>
    </div>
  )
}

/**
 * A guild as a List Row (46): its round tile (32), the name, the level and a chevron. ListRow
 * draws a square tinted tile, so the row draws its own.
 */
function GuildRow({ guild, value }: { guild: Guild; value: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => openDialog({ kind: 'notifySettings', guildId: guild.id })}
      className="active:bg-surface-hover focus-visible:outline-line-focus flex min-h-[46px] w-full items-center gap-3 py-1.5 pr-3.5 pl-3 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <GuildTile guild={guild} className="size-8 text-[12px]" />
      <span className="text-text-primary min-w-0 flex-1 truncate text-[15px] leading-[18px] font-bold">
        {guild.name}
      </span>
      <span className="text-text-tertiary shrink-0 text-[13.5px] leading-4 font-semibold">
        {value}
      </span>
      <ChevronRight aria-hidden className="text-text-disabled size-[17px] shrink-0" />
    </button>
  )
}
