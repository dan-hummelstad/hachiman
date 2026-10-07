import { ChevronRight, Settings, X } from 'lucide-react'
import { Keycap } from '@/components/ui/keycap'
import type { SettingsModel } from '@/components/settings/settings-model'
import { resolveSection } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'

interface SettingsPageProps {
  model: SettingsModel
  /** The picked section; an unknown or hidden one shows the first visible section. */
  section: string | null
  /** The `Esc ✕` button: leave settings. */
  onClose: () => void
}

/**
 * The content card of settings (F7…H6): the breadcrumb header ("Night Owls › Roles") with `Esc ✕`,
 * then the page: title, one-line description and the section body, about 720 px wide.
 */
export function SettingsPage({ model, section, onClose }: SettingsPageProps): React.JSX.Element {
  const item = resolveSection(model.groups, section)
  const page = item?.page
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-line-hairline flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Settings aria-hidden className="text-text-tertiary size-4 shrink-0" />
        <span className="text-text-tertiary truncate text-sm font-semibold">{model.crumb}</span>
        <ChevronRight aria-hidden className="text-text-disabled size-3.5 shrink-0" />
        <span className="text-text-primary flex-1 truncate text-sm font-bold">{page?.title}</span>
        <button
          type="button"
          aria-label="Close settings"
          onClick={onClose}
          className="rounded-control bg-surface-raised text-text-secondary hover:text-text-primary flex h-7 items-center gap-1.5 pr-2 pl-1"
        >
          <Keycap aria-hidden className="bg-transparent">
            Esc
          </Keycap>
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {page && (
          <main
            key={item?.id}
            className={cn(
              'mx-auto w-full p-7 pb-20',
              page.wide ? 'max-w-[876px]' : 'max-w-[776px]'
            )}
          >
            <h1 className="text-page-title text-text-primary">{page.title}</h1>
            {page.description && (
              <p className="text-body text-text-secondary mt-1.5">{page.description}</p>
            )}
            <div className="mt-6">{page.render()}</div>
          </main>
        )}
      </div>
    </div>
  )
}
