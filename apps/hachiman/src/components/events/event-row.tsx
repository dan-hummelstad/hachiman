import { useEffect, useState } from 'react'
import { CalendarHeart } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNextEvent } from '@/stores/eventsStore'
import { shortEventWhen } from './event-format'
import { EventDetails } from './event-popover'

/**
 * The amber event row under the guild header (B1, B10): the next event of the guild (ongoing, or
 * within 7 days) as "<title> · <when>" and "<n> going". A click opens the details. Nothing when
 * the guild has no such event.
 */
export function EventRow({ guildId }: { guildId: string }): React.JSX.Element | null {
  const event = useNextEvent(guildId)
  const [open, setOpen] = useState(false)
  const now = useMinuteClock()
  if (!event) return null

  const when = shortEventWhen(event, now)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="bg-feature-event/12 hover:bg-feature-event/18 data-[state=open]:bg-feature-event/18 rounded-control mt-2 flex h-[38px] w-full shrink-0 items-center gap-2.5 px-2.5 text-left"
        >
          <CalendarHeart className="text-feature-event-text size-4 shrink-0" aria-hidden />
          <span className="text-text-primary min-w-0 flex-1 truncate text-[13px] font-bold">
            {event.title} · {when}
          </span>
          <span className="text-feature-event-text shrink-0 text-xs font-bold tabular-nums">
            {event.rsvpCount} going
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] min-w-72"
      >
        <EventDetails event={event} now={now} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The time, updated once a minute, so "Now" and the day names stay current. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}
