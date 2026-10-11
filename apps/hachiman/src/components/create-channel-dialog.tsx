import { useState } from 'react'
import { CirclePlus, FolderPlus, Plus } from 'lucide-react'
import type { CreateChannelBody } from '@hachiman/client'
import { MobileField } from '@/components/mobile/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { Button } from '@/components/ui/button'
import { FEATURE_TEXT, type Feature } from '@/components/ui/feature'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioCard } from '@/components/ui/radio-card'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { useRevealOnKeyboard } from '@/hooks/use-visual-viewport'
import { ChannelIcon } from '@/lib/channel-icon'
import { CHANNEL_KINDS, CREATE_CHANNEL_TYPES, hasChat } from '@/lib/model'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { selectChannel } from '@/stores/navStore'

type ChannelKind = CreateChannelBody['type']

const FORM_ID = 'create-channel-form'

/** The feature colour of each type: its card, and the lead icon of the name field (M47). */
const featureOf = (type: ChannelKind): Feature =>
  type === 'voice' ? 'voice' : type === 'pages' ? 'page' : 'accent'

/**
 * Create a channel or category in a guild; a new text or pages channel becomes the selected one.
 * Text, voice and pages can be switched in the dialog. A new pages channel gets its root page,
 * "Untitled", from this client: only a client can encrypt the title.
 *
 * On the mobile layout (M47) it is a sheet with no Cancel: the type cards in their feature
 * colours, the name field with the type icon, and Create as one 48 button at the foot, which stays
 * in view over the keyboard. The field takes no autofocus, so the keyboard rises only on a tap.
 */
export function CreateChannelDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('createChannel')
  const { guildId, parentId } = dialog
  const [name, setName] = useState('')
  const [type, setType] = useState<ChannelKind>(dialog.type)
  const { run, busy, error } = useAction()
  const mobile = useLayout() === 'mobile'
  const nameRef = useRevealOnKeyboard<HTMLInputElement>()
  const parentName = useChannelStore((s) =>
    parentId ? (s.channels.get(parentId)?.name ?? null) : null
  )

  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name ?? null)

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
          .createPage(channel.id, 'Untitled', null)
          .catch((err: unknown) => console.warn('[pages] root page failed', err))
      }
      return channel
    })
    if (!created.ok) return
    if (hasChat(created.value.type)) selectChannel(created.value.id, guildId)
    close()
  }

  const submitLabel = busy ? 'Creating…' : isCategory ? 'Create category' : 'Create channel'

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={isCategory ? 'Create category' : 'Create channel'}
      icon={isCategory ? <FolderPlus /> : <CirclePlus />}
      description={
        isCategory
          ? 'Categories group channels in the sidebar.'
          : [parentName && `In ${parentName}`, guildName].filter(Boolean).join(' · ') || undefined
      }
      actions={
        mobile ? (
          <Button type="submit" form={FORM_ID} disabled={busy || !name.trim()}>
            <Plus />
            {submitLabel}
          </Button>
        ) : (
          <>
            <Button type="button" variant="quiet" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} disabled={busy || !name.trim()}>
              {!isCategory && <CirclePlus />}
              {submitLabel}
            </Button>
          </>
        )
      }
    >
      <form id={FORM_ID} onSubmit={(e) => void handleSubmit(e)} className="grid gap-4">
        {!isCategory && (
          <fieldset className="grid gap-2">
            <legend className="section-label mobile:px-1 mobile:pt-1 mb-2">Type</legend>
            {CREATE_CHANNEL_TYPES.map((t) => {
              const { label, hint } = CHANNEL_KINDS[t]
              return (
                <RadioCard
                  key={t}
                  name="channel-type"
                  value={t}
                  checked={type === t}
                  onChange={() => setType(t)}
                  icon={<ChannelIcon type={t} />}
                  title={label}
                  description={hint}
                  feature={featureOf(t)}
                  size={mobile ? 'mobile' : 'default'}
                />
              )
            })}
          </fieldset>
        )}
        {mobile ? (
          <MobileField
            id="channel-name"
            label={isCategory ? 'Category name' : 'Channel name'}
            error={error}
          >
            <Input
              ref={nameRef}
              size="touch"
              name="channel-name"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={CHANNEL_KINDS[type].placeholder}
              disabled={busy}
              lead={
                isCategory ? undefined : (
                  <ChannelIcon type={type} className={FEATURE_TEXT[featureOf(type)]} />
                )
              }
            />
          </MobileField>
        ) : (
          <div className="grid gap-2">
            <label htmlFor="channel-name" className="section-label">
              {isCategory ? 'Category name' : 'Channel name'}
            </label>
            <div className="relative">
              {!isCategory && (
                <span className="text-text-tertiary pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
                  <ChannelIcon type={type} className="size-4" />
                </span>
              )}
              <Input
                id="channel-name"
                name="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={CHANNEL_KINDS[type].placeholder}
                autoFocus
                disabled={busy}
                className={cn(!isCategory && 'pl-8')}
              />
            </div>
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </form>
    </ModalWindow>
  )
}
