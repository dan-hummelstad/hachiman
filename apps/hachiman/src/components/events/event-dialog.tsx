import { useMemo, useState } from 'react'
import { CalendarHeart } from 'lucide-react'
import type { UpdateGuildEventRequest } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { NativeSelect } from '@/components/ui/native-select'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useAction } from '@/hooks/use-action'
import { eventsService } from '@/services/guild-features'
import { useDialog } from '@/stores/dialogStore'
import { useEventsStore } from '@/stores/eventsStore'
import { useGuildStore } from '@/stores/guildStore'
import { validateEventForm, type EventForm } from './event-form'

const FORM_ID = 'guild-event-form'

const pad = (n: number): string => String(n).padStart(2, '0')
const dateValue = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeValue = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** A new event starts at the next full hour after one hour from now. */
function defaultStart(): Date {
  const d = new Date(Date.now() + 60 * 60_000)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

/** Create or edit a guild event (N14): title, start, optional end and voice channel. */
export function EventDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('guildEvent')
  const { guildId, eventId } = dialog
  const existing = useEventsStore((s) =>
    eventId !== null ? s.byGuild.get(guildId)?.find((e) => e.id === eventId) : undefined
  )
  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name ?? null)
  const channels = useGuildChannels(guildId)
  const voiceChannels = useMemo(() => channels.filter((c) => c.type === 'voice'), [channels])
  const { run, busy, error, setError } = useAction()

  const [form, setForm] = useState<EventForm>(() => {
    const start = existing ? new Date(existing.startsAt) : defaultStart()
    const end = existing?.endsAt ? new Date(existing.endsAt) : null
    return {
      title: existing?.title ?? '',
      startDate: dateValue(start),
      startTime: timeValue(start),
      endDate: end ? dateValue(end) : '',
      endTime: end ? timeValue(end) : '',
      channelId: existing?.channelId ?? ''
    }
  })
  const set = (patch: Partial<EventForm>): void => setForm((f) => ({ ...f, ...patch }))

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (eventId !== null && !existing) return setError('This event was deleted.')
    const v = validateEventForm(form, Date.now(), existing ?? null)
    if (!v.ok) return setError(v.error)
    const { body } = v
    const done = await run(existing ? 'save the event' : 'create the event', async () => {
      if (!existing) return eventsService.create(guildId, body)
      // Send only what changed: the server checks a sent start against the clock.
      const patch: UpdateGuildEventRequest = {}
      if (body.title !== existing.title) patch.title = body.title
      if (Date.parse(body.startsAt) !== Date.parse(existing.startsAt))
        patch.startsAt = body.startsAt
      const oldEnd = existing.endsAt === null ? null : Date.parse(existing.endsAt)
      const newEnd = body.endsAt === null ? null : Date.parse(body.endsAt)
      if (oldEnd !== newEnd) patch.endsAt = body.endsAt
      if (body.channelId !== existing.channelId) patch.channelId = body.channelId
      return eventsService.update(existing.id, patch)
    })
    if (done.ok) close()
  }

  const verb = existing ? 'Save' : 'Create event'
  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={existing ? 'Edit event' : 'Create event'}
      description={guildName ? `${guildName} · Members can see the title and time.` : undefined}
      icon={<CalendarHeart />}
      feature="event"
      actions={
        <>
          <Button type="button" variant="quiet" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={busy || !form.title.trim()}>
            {busy ? 'Saving…' : verb}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={(e) => void handleSubmit(e)} className="grid gap-4">
        <Field id="event-title" label="Title">
          <Input
            id="event-title"
            value={form.title}
            maxLength={100}
            autoFocus
            placeholder="Scrims"
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="event-start-date" label="Start date">
            <Input
              id="event-start-date"
              type="date"
              required
              value={form.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
            />
          </Field>
          <Field id="event-start-time" label="Start time">
            <Input
              id="event-start-time"
              type="time"
              required
              value={form.startTime}
              onChange={(e) => set({ startTime: e.target.value })}
            />
          </Field>
          <Field id="event-end-date" label="End date (optional)">
            <Input
              id="event-end-date"
              type="date"
              value={form.endDate}
              onChange={(e) => set({ endDate: e.target.value })}
            />
          </Field>
          <Field id="event-end-time" label="End time">
            <Input
              id="event-end-time"
              type="time"
              value={form.endTime}
              onChange={(e) => set({ endTime: e.target.value })}
            />
          </Field>
        </div>
        <Field
          id="event-channel"
          label="Voice channel"
          hint="Optional. Members can join from the event."
        >
          <NativeSelect
            id="event-channel"
            className="w-full"
            value={form.channelId}
            onChange={(e) => set({ channelId: e.target.value })}
          >
            <option value="">No channel</option>
            {voiceChannels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <ErrorText>{error}</ErrorText>
      </form>
    </ModalWindow>
  )
}
