import { useState } from 'react'
import type { CreateChannelBody } from '@hachiman/client'
import { ModalWindow } from '@/components/ui/modal-window'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAction } from '@/hooks/use-action'
import { ChannelIcon } from '@/lib/channel-icon'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDialog } from '@/stores/dialogStore'
import { selectChannel } from '@/stores/navStore'

type ChannelKind = CreateChannelBody['type']

const FORM_ID = 'create-channel-form'

const TYPES = [
  { type: 'text', label: 'Text', hint: 'Send messages, links and code' },
  { type: 'voice', label: 'Voice', hint: 'Talk together with voice' },
  { type: 'pages', label: 'Pages', hint: 'Write documents together, next to the chat' }
] as const

/**
 * Create a channel or category in a guild; a new text or pages channel becomes the selected one.
 * Text, voice and pages can be switched in the dialog. A new pages channel gets its root page,
 * "Untitled", from this client: only a client can encrypt the title.
 */
export function CreateChannelDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('createChannel')
  const { guildId, parentId } = dialog
  const [name, setName] = useState('')
  const [type, setType] = useState<ChannelKind>(dialog.type)
  const { run, busy, error } = useAction()
  const parentName = useChannelStore((s) =>
    parentId ? (s.channels.get(parentId)?.name ?? null) : null
  )

  const isCategory = type === 'category'

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const created = await run(`create the ${type}`, async () => {
      const channel = await hachiman.rest.createChannel(guildId, {
        name: trimmed,
        type,
        parentId: isCategory ? undefined : (parentId ?? undefined)
      })
      if (channel.type === 'pages') {
        // The channel exists already: a failed root page must not fail the action (a retry
        // would make a second channel). The pages panel offers to make a page when it has none.
        await docsService
          .createPage(channel.id, 'Untitled', { parentId: null })
          .catch((err: unknown) => console.warn('[pages] root page failed', err))
      }
      return channel
    })
    if (!created.ok) return
    const channel = created.value
    if (channel.type === 'text' || channel.type === 'pages') selectChannel(channel.id, guildId)
    close()
  }

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={isCategory ? 'Create category' : 'Create channel'}
      description={
        parentName
          ? `In ${parentName}`
          : isCategory
            ? 'Categories group channels in the sidebar.'
            : undefined
      }
      actions={
        <>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : isCategory ? 'Create category' : 'Create channel'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={(e) => void handleSubmit(e)} className="grid gap-4">
        {!isCategory && (
          <fieldset className="grid gap-2">
            <legend className="text-muted-foreground mb-2 text-xs leading-4 font-semibold">
              Type
            </legend>
            {TYPES.map(({ type: t, label, hint }) => {
              const selected = type === t
              return (
                <label
                  key={t}
                  className={cn(
                    'has-focus-visible:outline-ring flex cursor-pointer items-center gap-3 border px-3 py-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-1',
                    selected ? 'bg-accent border-primary' : 'hover:bg-accent/60'
                  )}
                >
                  <input
                    type="radio"
                    name="channel-type"
                    value={t}
                    checked={selected}
                    onChange={() => setType(t)}
                    className="sr-only"
                  />
                  <ChannelIcon type={t} className="text-muted-foreground size-4 shrink-0" />
                  <span className="grid">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-muted-foreground text-xs">{hint}</span>
                  </span>
                </label>
              )
            })}
          </fieldset>
        )}
        <div className="grid gap-2">
          <Label htmlFor="channel-name">{isCategory ? 'Category name' : 'Channel name'}</Label>
          <div className="relative">
            {!isCategory && (
              <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
                <ChannelIcon type={type} className="size-4" />
              </span>
            )}
            <Input
              id="channel-name"
              name="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                type === 'voice'
                  ? 'Lounge'
                  : type === 'pages'
                    ? 'design-pages'
                    : isCategory
                      ? 'Text'
                      : 'general'
              }
              autoFocus
              disabled={busy}
              className={cn(!isCategory && 'pl-8')}
            />
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
      </form>
    </ModalWindow>
  )
}
