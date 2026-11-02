import { X } from 'lucide-react'
import type { SettingsModel } from '@/components/settings/settings-model'
import { SettingsNav } from '@/components/settings/settings-nav'
import { IconButton } from '@/components/ui/icon-button'
import { resolveSection } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'

interface SettingsPageProps {
  model: SettingsModel
  /** The picked section; an unknown or hidden one shows the first visible section. */
  section: string | null
  /** The ✕ button: leave settings. */
  onClose: () => void
  /** With it the page draws its own section column (the app sidebar stays beside it). */
  onSelect?: (section: string) => void
}

/** "You / Appearance": the group of the section, then the section. */
function crumbOf(model: SettingsModel, id: string | undefined, label: string): string {
  const group = model.groups.find((g) => g.items.some((i) => i.id === id))
  const root = model.label === 'User settings' ? group?.heading : undefined
  return `${root ?? model.crumb} / ${label}`
}

/**
 * The content card of settings: the section column (when `onSelect` is given), then the page: a
 * mono crumb, the title, a one-line description, a hairline and the section body.
 */
export function SettingsPage({
  model,
  section,
  onClose,
  onSelect
}: SettingsPageProps): React.JSX.Element {
  const item = resolveSection(model.groups, section)
  const page = item?.page
  return (
    <div className="flex h-full min-h-0">
      {onSelect && (
        <SettingsNav model={model} section={section} onSelect={onSelect} onBack={onClose} />
      )}
      <div className="bg-surface-content relative min-w-0 flex-1 overflow-y-auto">
        <IconButton
          label="Close settings"
          onClick={onClose}
          className="absolute top-4 right-4 size-7"
        >
          <X className="size-4" />
        </IconButton>
        {page && item && (
          <main
            key={item.id}
            className={cn(
              'w-full px-11 pt-[34px] pb-20',
              page.wide ? 'max-w-none' : 'max-w-[936px]'
            )}
          >
            <p className="text-text-disabled font-mono text-[9px] tracking-[1.5px] uppercase">
              {crumbOf(model, item.id, item.label)}
            </p>
            <h1 className="text-page-title text-text-primary mt-2.5 tracking-[-0.7px]">
              {page.title}
            </h1>
            {page.description && (
              <p className="text-text-tertiary mt-1.5 text-[13.5px] leading-5">
                {page.description}
              </p>
            )}
            <div aria-hidden className="bg-line-hairline mt-[26px] mb-[22px] h-px" />
            {page.render()}
          </main>
        )}
      </div>
    </div>
  )
}
