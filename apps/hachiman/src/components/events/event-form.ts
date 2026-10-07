import type { GuildEvent } from '@hachiman/client'

/** The fields of the event dialog: native date ('YYYY-MM-DD') and time ('HH:MM') input values. */
export interface EventForm {
  title: string
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  /** '' = no voice channel. */
  channelId: string
}

export interface EventBody {
  title: string
  startsAt: string
  endsAt: string | null
  channelId: string | null
}

export const MAX_EVENT_TITLE = 100

/** Local date and time input values to a time, or null when invalid. */
function localTime(date: string, time: string): number | null {
  if (!date || !time) return null
  const t = new Date(`${date}T${time}`).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * The server rules (Takusen lib/guild-events.ts): a title of 1–100 characters after trim; a start
 * in the future when it is sent (always on a create; on an edit only when it changed); an end
 * after the start. An end time without a date takes the start date.
 */
export function validateEventForm(
  form: EventForm,
  now: number,
  existing: Pick<GuildEvent, 'startsAt'> | null
): { ok: true; body: EventBody } | { ok: false; error: string } {
  const title = form.title.trim()
  if (!title) return { ok: false, error: 'Give the event a title.' }
  if (title.length > MAX_EVENT_TITLE)
    return { ok: false, error: `The title can have at most ${MAX_EVENT_TITLE} characters.` }

  const start = localTime(form.startDate, form.startTime)
  if (start === null) return { ok: false, error: 'Set a start date and time.' }
  const startChanged = existing === null || Date.parse(existing.startsAt) !== start
  if (startChanged && start <= now) return { ok: false, error: 'The start must be in the future.' }

  let end: number | null = null
  if (form.endDate || form.endTime) {
    end = localTime(form.endDate || form.startDate, form.endTime)
    if (end === null) return { ok: false, error: 'Set an end time, or clear the end.' }
    if (end <= start) return { ok: false, error: 'The end must be after the start.' }
  }

  return {
    ok: true,
    body: {
      title,
      startsAt: new Date(start).toISOString(),
      endsAt: end === null ? null : new Date(end).toISOString(),
      channelId: form.channelId || null
    }
  }
}
