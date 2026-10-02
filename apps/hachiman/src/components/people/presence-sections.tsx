import { useMemo } from 'react'
import { partitionByPresence } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'

/**
 * A people directory split into "Online — N" and "Offline — N" sections (empty ones hidden),
 * input order kept. `renderRow` returns the `<li>`; `offline` tells it to render dimmed.
 */
export function PresenceSections<T>(props: {
  items: readonly T[]
  /** Keep stable (module-level) — it's a memo dependency. */
  idOf: (item: T) => string
  renderRow: (item: T, offline: boolean) => React.ReactNode
  /** Extra classes for the section headings (spacing differs per pane). */
  labelClassName?: string
}): React.JSX.Element {
  const { items, idOf } = props
  const presences = useGuildStore((s) => s.presences)
  const [online, offline] = useMemo(
    () => partitionByPresence(items, idOf, presences),
    [items, idOf, presences]
  )
  const section = (title: string, list: T[], dim: boolean): React.ReactNode =>
    list.length > 0 && (
      <section>
        <h3 className={cn('section-label', props.labelClassName)}>
          {title} — {list.length}
        </h3>
        <ul className="flex flex-col">{list.map((item) => props.renderRow(item, dim))}</ul>
      </section>
    )
  return (
    <>
      {section('Online', online, false)}
      {section('Offline', offline, true)}
    </>
  )
}
