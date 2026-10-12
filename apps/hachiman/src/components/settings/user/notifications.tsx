import { useId, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { useDeviceNoun } from '@/components/security/onboarding-steps'
import { GuildTile } from '@/components/ui/guild-tile'
import { guildNotifyLevel, notifyLevelLabel, type NotifyPrefs } from '@/lib/notify'
import { orderedIds } from '@/lib/sidebar-tiles'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useGuildOrder, useNotifyPrefs } from '@/stores/prefsStore'

/** The value of a guild row: "Muted", else the guild's level ("Mentions"). */
function guildNotifyValue(prefs: NotifyPrefs, guildId: string): string {
  return prefs.muted.includes(guildId)
    ? 'Muted'
    : notifyLevelLabel(guildNotifyLevel(prefs, guildId))
}

/**
 * User settings → Notifications on the mobile layout (M33). Today only GUILD OVERRIDES: one row
 * per guild, in my guild order, with its level or "Muted". A tap opens the guild's notification
 * settings as a sheet. Push notifications, the lock screen and quiet hours come with push
 * (spec §5), so a line says that phone notifications come later.
 */
export function NotificationsSection(): React.JSX.Element {
  const guilds = useGuildStore((s) => s.guilds)
  const order = useGuildOrder()
  const prefs = useNotifyPrefs()
  const noun = useDeviceNoun()
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
        Notifications on this {noun} come later. For now, these choose what counts as unread and
        plays a sound while Hachiman is open.
      </p>
    </section>
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
