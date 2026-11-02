import { ArrowLeft } from 'lucide-react'
import type { SettingsModel } from '@/components/settings/settings-model'
import { UnreadMark } from '@/components/ui/unread-mark'
import { isVisible, resolveSection } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useSelectedChannelId } from '@/stores/navStore'

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
 * The 224 px settings column: "Settings" back row, the section list with counts and the quiet
 * action (Sign out, or the red Leave / Delete) at the foot. The selected row wears the `here`
 * mark.
 */
export function SettingsNav({
  model,
  section,
  onSelect,
  onBack
}: SettingsNavProps): React.JSX.Element {
  const selected = resolveSection(model.groups, section)?.id
  const back = useBackLabel()
  const user = model.label === 'User settings'
  return (
    <nav
      aria-label={model.label}
      className="bg-surface-panel border-line-hairline flex h-full w-[224px] shrink-0 flex-col border-r"
    >
      <button
        type="button"
        aria-label={back}
        onClick={onBack}
        className="text-text-tertiary hover:text-text-primary flex h-[52px] shrink-0 items-center gap-2 px-4"
      >
        <ArrowLeft aria-hidden className="size-[15px]" />
        <span className="font-mono text-[9.5px] tracking-[1.5px] uppercase">
          {user ? 'Settings' : model.crumb}
        </span>
      </button>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pt-1">
        {model.groups.map((g, i) => {
          const items = g.items.filter(isVisible)
          if (items.length === 0) return null
          return (
            <div key={g.heading ?? i} className="flex flex-col gap-px">
              {g.heading && (
                <h2 className="text-text-disabled flex h-[30px] items-center px-2.5 font-mono text-[9px] tracking-[1.3px] uppercase">
                  {g.heading}
                </h2>
              )}
              {items.map((s) => {
                const on = s.id === selected
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => onSelect(s.id)}
                    className={cn(
                      'rounded-row relative flex h-8 items-center gap-2 px-2.5 text-left text-[13px]',
                      on
                        ? 'bg-surface-selected text-text-primary font-semibold'
                        : 'text-text-tertiary hover:bg-surface-hover hover:text-text-secondary'
                    )}
                  >
                    {on && (
                      <span
                        aria-hidden
                        className="bg-here absolute top-1/2 left-0 h-[18px] w-0.5 -translate-y-1/2"
                      />
                    )}
                    <span className="flex-1 truncate">{s.label}</span>
                    {s.alert !== undefined && s.alert > 0 ? (
                      <UnreadMark badge={{ mentions: s.alert, unread: false }} count />
                    ) : (
                      s.count !== undefined &&
                      s.count > 0 && (
                        <span className="text-text-disabled font-mono text-[9px] tabular-nums">
                          {s.count}
                        </span>
                      )
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {model.danger && (
        <button
          type="button"
          disabled={model.danger.disabled}
          onClick={model.danger.onClick}
          className={cn(
            'border-line-hairline flex h-[52px] shrink-0 items-center gap-2 border-t px-4 text-[13px] disabled:opacity-50 [&_svg]:size-[15px]',
            model.danger.quiet
              ? 'text-text-secondary hover:text-text-primary [&_svg]:text-text-tertiary'
              : 'text-you-text hover:bg-you-tint'
          )}
        >
          {model.danger.icon}
          {model.danger.label}
        </button>
      )}
    </nav>
  )
}
