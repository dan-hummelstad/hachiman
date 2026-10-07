import { useState } from 'react'
import { Hash } from 'lucide-react'
import type { Channel, HistoryVisibility } from '@hachiman/client'
import { ErrorText, Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { SaveBar } from '@/components/settings/save-bar'
import { useAction } from '@/hooks/use-action'
import { trimName, useDraft } from '@/hooks/use-draft'
import { useKeyedAsync } from '@/hooks/use-keyed-async'
import { adminActionService } from '@/services/AdminActionService'
import { hachiman } from '@/services/hachiman'

const TOPIC_MAX = 1024

/** Channel settings → Overview (F7): name, topic with a live header preview, earlier messages. */
export function ChannelOverviewPage({
  channel,
  editable
}: {
  channel: Channel
  editable: boolean
}): React.JSX.Element {
  const draft = useDraft({ name: channel.name ?? '', topic: channel.topic ?? '' }, trimName)
  const { name, topic } = draft.value
  const { run, busy, error, clearError } = useAction()
  const isText = channel.type === 'text'
  const hashed = channel.type !== 'category'

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const saved = await run('save changes', () =>
      hachiman.rest.updateChannel(channel.id, {
        name: name.trim(),
        topic: isText ? topic.trim() || null : undefined
      })
    )
    if (saved.ok) draft.markSaved()
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-5">
      <Field
        id="channel-name-edit"
        label={channel.type === 'category' ? 'Category name' : 'Channel name'}
      >
        <div className="relative">
          {hashed && (
            <Hash
              aria-hidden
              className="text-text-tertiary pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
          )}
          <Input
            id="channel-name-edit"
            value={name}
            maxLength={100}
            disabled={!editable}
            className={hashed ? 'h-10 pl-9' : 'h-10'}
            onChange={(e) => draft.set({ name: e.target.value })}
          />
        </div>
      </Field>
      {isText && (
        <>
          <Field
            id="channel-topic"
            label="Topic"
            hint="Shown in the channel’s title bar. Tell people what the channel is for."
          >
            <div className="relative">
              <Textarea
                id="channel-topic"
                value={topic}
                maxLength={TOPIC_MAX}
                disabled={!editable}
                className="min-h-24 pb-6"
                onChange={(e) => draft.set({ topic: e.target.value })}
              />
              <span
                aria-hidden
                className="text-meta text-text-tertiary pointer-events-none absolute right-3 bottom-2 tabular-nums"
              >
                {topic.length} / {TOPIC_MAX}
              </span>
            </div>
          </Field>
          <div className="grid gap-1.5">
            <span className="text-xs leading-4 font-semibold">Preview</span>
            <div
              aria-label="Header preview"
              className="bg-surface-panel border-line-hairline flex h-12 min-w-0 items-center gap-2 border px-4"
            >
              <Hash aria-hidden className="text-text-tertiary size-4 shrink-0" />
              <span className="text-heading shrink-0">{name.trim() || channel.name}</span>
              <span className="text-text-tertiary truncate pl-2 text-[13px]">{topic.trim()}</span>
            </div>
          </div>
        </>
      )}
      {!editable && (
        <p className="text-meta text-text-tertiary">
          You need the Manage channels permission to change these.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      {editable && (
        <SaveBar
          dirty={draft.dirty}
          saved={draft.saved}
          busy={busy}
          disabled={!name.trim()}
          onReset={() => {
            draft.reset()
            clearError()
          }}
        />
      )}
      {isText && channel.guildId && (
        <HistoryVisibilityField channel={channel} editable={editable} />
      )}
    </form>
  )
}

/** The MLS group kind of a channel: 'channel' when it has its own group (§12.6). */
const groupKindOf = (channelId: string): Promise<string | null> =>
  hachiman.rest.getChannelMlsGroup(channelId).then((g) => g?.kind ?? null)

/**
 * History visibility of a channel with its own group (§12.6): `joined` (new members see only
 * new messages) or `shared` (members send the earlier message keys to new members). Public
 * channels share the guild's group and its setting (guild settings → Overview).
 */
function HistoryVisibilityField({
  channel,
  editable
}: {
  channel: Channel
  editable: boolean
}): React.JSX.Element | null {
  const kind = useKeyedAsync(channel.id, groupKindOf)
  const { run, busy, error } = useAction()
  const [saved, setSaved] = useState(false)
  if (kind?.data !== 'channel') return null
  const value = channel.historyVisibility ?? 'joined'

  const change = async (next: HistoryVisibility): Promise<void> => {
    setSaved(false)
    const r = await run('change who can read earlier messages', () =>
      adminActionService.updateChannel(channel.id, { historyVisibility: next })
    )
    if (r.ok) setSaved(true)
  }

  return (
    <div className="border-line-hairline grid gap-2 border-t pt-5">
      <Field
        id="channel-history"
        label="Earlier messages for new members"
        hint={
          value === 'shared'
            ? 'New members can read the messages from before they joined. A member device sends them the keys.'
            : 'New members see only the messages that come after they join.'
        }
      >
        <NativeSelect
          id="channel-history"
          className="w-full"
          value={value}
          disabled={!editable || busy}
          onChange={(e) => void change(e.target.value as HistoryVisibility)}
        >
          <option value="joined">Hide earlier messages</option>
          <option value="shared">Show earlier messages</option>
        </NativeSelect>
      </Field>
      {saved && <span className="text-meta text-text-tertiary">Changes saved.</span>}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
