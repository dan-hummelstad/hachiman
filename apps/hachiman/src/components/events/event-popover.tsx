import { useState } from 'react'
import { CalendarHeart, Check, Pencil, Trash2 } from 'lucide-react'
import { Permissions, has, type GuildEventWithMe } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { ChannelIcon } from '@/lib/channel-icon'
import { cn } from '@/lib/utils'
import { eventsService } from '@/services/guild-features'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import { selectChannel } from '@/stores/navStore'
import { isOngoing } from '@/stores/eventsStore'
import { fullEventRange } from './event-format'

/**
 * The details of a guild event (N14): title, the full time range in the viewer's locale, the
 * voice channel (opens it), the "Going" toggle, and edit and delete for MANAGE_EVENTS.
 */
export function EventDetails({
  event,
  now,
  onDone
}: {
  event: GuildEventWithMe
  now: number
  /** Closes the popover (after open channel, edit, delete). */
  onDone: () => void
}): React.JSX.Element {
  const canManage = has(usePermissions(event.guildId), Permissions.MANAGE_EVENTS)
  const channelName = useChannelStore((s) =>
    event.channelId !== null ? (s.channels.get(event.channelId)?.name ?? null) : null
  )
  const { run, busy, error } = useAction()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ongoing = isOngoing(event, now)

  const toggleGoing = (): void =>
    void run('change your RSVP', () => eventsService.rsvp(event.id, !event.me))

  const remove = async (): Promise<void> => {
    const r = await run('delete the event', () => eventsService.delete(event.id))
    if (r.ok) onDone()
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2.5">
        <span className="bg-feature-event/15 text-feature-event-text rounded-control grid size-8 shrink-0 place-items-center">
          <CalendarHeart className="size-4" aria-hidden />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <p className="text-text-primary text-sm leading-5 font-bold break-words">{event.title}</p>
          <p className="text-text-secondary text-xs leading-4">
            {ongoing && <span className="text-feature-event-text font-semibold">Now · </span>}
            {fullEventRange(event)}
          </p>
        </div>
      </div>

      {event.channelId !== null && channelName !== null && (
        <button
          type="button"
          onClick={() => {
            selectChannel(event.channelId, event.guildId)
            onDone()
          }}
          className="rounded-control text-feature-voice-text hover:bg-surface-hover flex h-7 items-center gap-2 px-1.5 text-left text-[13px] font-semibold"
        >
          <ChannelIcon type="voice" className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{channelName}</span>
        </button>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={event.me ? 'secondary' : 'primary'}
          aria-pressed={event.me}
          disabled={busy}
          onClick={toggleGoing}
          className={cn(event.me && 'border-feature-event text-feature-event-text')}
        >
          {event.me && <Check />}
          Going
        </Button>
        <span className="text-text-tertiary text-xs font-semibold tabular-nums">
          {event.rsvpCount} going
        </span>
        <span className="flex-1" />
        {canManage && !confirmDelete && (
          <>
            <Button
              size="icon-sm"
              variant="quiet"
              aria-label="Edit event"
              onClick={() => {
                onDone()
                openDialog({ kind: 'guildEvent', guildId: event.guildId, eventId: event.id })
              }}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="quiet"
              aria-label="Delete event"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>

      {confirmDelete && (
        <div className="flex items-center gap-2">
          <span className="text-text-secondary flex-1 text-xs">
            Delete this event for everyone?
          </span>
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
