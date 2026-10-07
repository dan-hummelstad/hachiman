import { ChevronLeft } from 'lucide-react'
import { Keycap } from '@/components/ui/keycap'
import {
  useChannelSettingsModel,
  useGuildSettingsModel,
  useUserSettingsModel,
  isVisible,
  resolveSection,
  type SettingsModel
} from '@/components/settings/settings-model'
import { useOwnDevices } from '@/components/security/devices-panel'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useSelectedChannelId, type SettingsTarget } from '@/stores/navStore'
import { useCryptoStore } from '@/stores/cryptoStore'

interface SettingsNavProps {
  target: SettingsTarget
  /** The picked section; an unknown or hidden one shows the first visible section. */
  section: string | null
  onSelect: (section: string) => void
  /** The back row and `Esc`: leave settings. */
  onBack: () => void
}

/**
 * The settings list of the sidebar middle (F7, G1, H1): the "Back to #channel" row, the header of
 * the thing being set up, the section list with counts, and the red action set apart.
 */
export function SettingsNav(props: SettingsNavProps): React.JSX.Element {
  const { target } = props
  if (target.kind === 'user') return <UserNav {...props} />
  if (target.kind === 'guild') return <GuildNav {...props} guildId={target.guildId} />
  return <ChannelNav {...props} channelId={target.channelId} />
}

function UserNav(props: SettingsNavProps): React.JSX.Element {
  const model = useUserSettingsModel()
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const { devices } = useOwnDevices(encryption)
  const count = devices?.filter((d) => d.status !== 'revoked').length
  return <SettingsNavView {...props} model={withCount(model, 'devices', count)} />
}

/** `model` with `count` on the item `id`. */
function withCount(model: SettingsModel, id: string, count: number | undefined): SettingsModel {
  if (count === undefined) return model
  return {
    ...model,
    groups: model.groups.map((g) => ({
      ...g,
      items: g.items.map((s) => (s.id === id ? { ...s, count } : s))
    }))
  }
}

function GuildNav(props: SettingsNavProps & { guildId: string }): React.JSX.Element {
  return <SettingsNavView {...props} model={useGuildSettingsModel(props.guildId)} />
}

function ChannelNav(props: SettingsNavProps & { channelId: string }): React.JSX.Element {
  return <SettingsNavView {...props} model={useChannelSettingsModel(props.channelId)} />
}

function useBackLabel(): string {
  const channelId = useSelectedChannelId()
  const name = useChannelStore((s) => (channelId ? s.channels.get(channelId)?.name : undefined))
  return name ? `Back to #${name}` : 'Back'
}

function SettingsNavView({
  model,
  section,
  onSelect,
  onBack
}: Omit<SettingsNavProps, 'target'> & { model: SettingsModel }): React.JSX.Element {
  const selected = resolveSection(model, section)
  const back = useBackLabel()
  return (
    <nav aria-label={model.label} className="flex min-h-0 flex-col gap-1">
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
                  className={cn(
                    'rounded-control flex h-8 items-center gap-2.5 px-2.5 text-left text-sm font-semibold transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                    on
                      ? 'bg-surface-selected text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
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
