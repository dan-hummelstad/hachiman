import { useState } from 'react'
import { Hash, Volume2 } from 'lucide-react'
import type { CreateChannelBody } from '@hachiman/client'
import { ModalWindow } from '@/components/ui/modal-window'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDialog } from '@/stores/dialogStore'
import { selectChannel } from '@/stores/navStore'

type ChannelKind = CreateChannelBody['type']

const FORM_ID = 'create-channel-form'

/**
 * Create a channel or category in a guild; a new text channel becomes the selected one. Text and
 * voice can be switched in the dialog.
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
    const created = await run(`create the ${type}`, () =>
      hachiman.rest.createChannel(guildId, {
        name: trimmed,
        type,
        parentId: isCategory ? undefined : (parentId ?? undefined)
      })
    )
    if (!created.ok) return
    if (created.value.type === 'text') selectChannel(created.value.id, guildId)
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
            {(['text', 'voice'] as const).map((t) => {
              const Icon = t === 'voice' ? Volume2 : Hash
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
                  <Icon className="text-muted-foreground size-4 shrink-0" />
                  <span className="grid">
                    <span className="text-sm font-medium">{t === 'voice' ? 'Voice' : 'Text'}</span>
                    <span className="text-muted-foreground text-xs">
                      {t === 'voice' ? 'Talk together with voice' : 'Send messages, links and code'}
                    </span>
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
                {type === 'voice' ? <Volume2 className="size-4" /> : <Hash className="size-4" />}
              </span>
            )}
            <Input
              id="channel-name"
              name="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 'voice' ? 'Lounge' : isCategory ? 'Text' : 'general'}
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
