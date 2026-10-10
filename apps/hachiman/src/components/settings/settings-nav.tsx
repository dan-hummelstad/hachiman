import { ChevronLeft } from 'lucide-react'
import { Keycap } from '@/components/ui/keycap'
import type { SettingsModel } from '@/components/settings/settings-model'
import { useChannelStore } from '@/stores/channelStore'
import { isVisible, resolveSection } from '@/lib/settings-sections'
import { useSelectedChannelId } from '@/stores/navStore'
import { selectableRowClass } from '@/components/ui/selectable-row'

interface SettingsNavProps {
  model: SettingsModel
  /** The picked section; an unknown or hidden one shows the first visible section. */
  section: string | null
  onSelect: (section: string) => void
  /** The back row and `Esc`: leave settings. */
  onBack: () => void
}

function useBackLabel(): string {
  const channelId = useSelectedChannelId()
  const name = useChannelStore((s) => (channelId ? s.channels.get(channelId)?.name : undefined))
  return name ? `Back to #${name}` : 'Back'
}

/**
 * The settings list of the sidebar middle (F7, G1, H1): the "Back to #channel" row, the header of
 * the thing being set up, the section list with counts, and the red action set apart.
 */
export function SettingsNav({
  model,
  section,
  onSelect,
  onBack
}: SettingsNavProps): React.JSX.Element {
  const selected = resolveSection(model.groups, section)?.id
  const back = useBackLabel()
  return (
    <nav
      aria-label={model.label}
      className="-mx-2.5 flex min-h-0 flex-col gap-1 overflow-y-auto px-2.5 pb-2 [&>*]:shrink-0"
    >
      <button
        type="button"
        onClick={onBack}
        className="rounded-control text-text-tertiary hover:bg-surface-hover hover:text-text-primary flex h-8 items-center gap-1.5 px-1.5 text-[13px] font-semibold"
      >
        <ChevronLeft aria-hidden className="size-4" />
        <span className="flex-1 truncate text-left">{back}</span>
        <Keycap aria-hidden>Esc</Keycap>
      </button>
      <div className="flex items-center gap-2.5 px-1 py-2">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center">
          {model.header.icon}
        </span>
        <span className="grid min-w-0">
          <span className="text-heading text-text-primary truncate">{model.header.name}</span>
          <span className="text-meta text-text-tertiary truncate">{model.header.subtitle}</span>
        </span>
      </div>
      {model.groups.map((g, i) => {
        const items = g.items.filter(isVisible)
        if (items.length === 0) return null
        return (
          <div key={g.heading ?? i} className="flex flex-col gap-0.5">
            {g.heading && <h2 className="section-label px-2.5 pt-3 pb-1">{g.heading}</h2>}
            {items.map((s) => {
              const on = s.id === selected
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => onSelect(s.id)}
                  className={selectableRowClass(
                    on,
                    'flex h-8 items-center gap-2.5 px-2.5 text-left text-sm font-semibold transition-colors [&_svg]:size-4 [&_svg]:shrink-0'
                  )}
                >
                  <span aria-hidden className={on ? 'text-accent-text' : 'text-text-tertiary'}>
                    {s.icon}
                  </span>
                  <span className="flex-1 truncate">{s.label}</span>
                  {s.count !== undefined && s.count > 0 && (
                    <span className="rounded-check bg-surface-raised text-text-tertiary px-1.5 text-[11px] leading-4 font-bold tabular-nums">
                      {s.count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
      {model.danger && (
        <div className="border-line-hairline mt-2 border-t pt-2">
          <button
            type="button"
            disabled={model.danger.disabled}
            onClick={model.danger.onClick}
            className="rounded-control text-feature-danger-text hover:bg-feature-danger/10 flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-sm font-semibold disabled:opacity-50 [&_svg]:size-4"
          >
            {model.danger.icon}
            {model.danger.label}
          </button>
        </div>
      )}
    </nav>
  )
}
