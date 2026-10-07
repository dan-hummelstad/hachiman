import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/** The sensors of every sortable list: a drag starts after 4 px, so a click stays a click. */
export function useDragSensors(): ReturnType<typeof useSensors> {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
}

/**
 * One row of a sortable list, with its drag style: lifted above its neighbours and dimmed while
 * dragged. `translateOnly` keeps the row's size (tabs of different widths).
 */
export function useSortableRow({
  id,
  disabled,
  translateOnly = false,
  dim = !translateOnly
}: {
  id: string
  disabled?: boolean
  translateOnly?: boolean
  /** Default: true unless `translateOnly`. */
  dim?: boolean
}): Omit<ReturnType<typeof useSortable>, 'transform' | 'transition'> & {
  style: React.CSSProperties
} {
  const { transform, transition, ...sortable } = useSortable({ id, disabled })
  const style: React.CSSProperties = {
    transform: (translateOnly ? CSS.Translate : CSS.Transform).toString(transform),
    transition,
    opacity: dim && sortable.isDragging ? 0.5 : undefined,
    zIndex: sortable.isDragging ? 1 : undefined
  }
  return { ...sortable, style }
}
