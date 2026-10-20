import { useId } from 'react'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { SectionHeading } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

const HINT =
  'When you send a link, this device opens the page and adds a preview to the encrypted message. The site sees your IP address. Others never open the link to make it.'

/**
 * The link previews switch (§12.8.1, `prefsStore.linkPreviews`). Hidden where the host cannot
 * fetch a page (the browser): previews come only from other devices there.
 */
export function LinkPreviewSetting({ mobile }: { mobile: boolean }): React.JSX.Element | null {
  const canFetch = usePlatform().fetchLinkResource !== null
  const on = usePrefsStore((s) => s.linkPreviews)
  const setOn = usePrefsStore((s) => s.setLinkPreviews)
  const id = useId()
  if (!canFetch) return null
  if (mobile)
    return (
      <section className="flex flex-col gap-1.5" aria-labelledby={`${id}-heading`}>
        <SectionLabel id={`${id}-heading`}>Links</SectionLabel>
        <ListGroup>
          <div className="flex min-h-[50px] items-center gap-3 px-3.5">
            <label
              htmlFor={id}
              className="text-text-primary flex flex-1 cursor-pointer items-center self-stretch text-[15px] leading-[18px] font-bold"
            >
              Make link previews
            </label>
            <Switch size="touch" id={id} checked={on} onCheckedChange={setOn} />
          </div>
        </ListGroup>
        <p className="text-text-tertiary px-1 pt-1 text-[12.5px] leading-[18px] font-medium">
          {HINT}
        </p>
      </section>
    )
  return (
    <section className="grid gap-2">
      <SectionHeading className="mb-0">Links</SectionHeading>
      <div className="flex items-center gap-3">
        <Switch id={id} checked={on} onCheckedChange={setOn} />
        <label htmlFor={id} className="text-label cursor-pointer">
          Make link previews
        </label>
      </div>
      <p className="text-text-tertiary text-sm">{HINT}</p>
    </section>
  )
}
