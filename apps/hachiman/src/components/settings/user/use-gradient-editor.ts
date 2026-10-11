import { useState } from 'react'
import { addedStop, withoutStop } from '@/lib/gradient-pad'
import { MAX_GRADIENT_STOPS, type CustomGradient, type GradientStop } from '@/lib/guild-tint'

/**
 * The state of a gradient editor (desktop `GradientPicker`, phone `GradientPickerMobile`): the
 * selected stop, and the edits of `value` through `onChange`.
 */
export function useGradientEditor(
  value: CustomGradient,
  onChange: (value: CustomGradient) => void
): {
  active: number
  select: (i: number) => void
  setStop: (i: number, stop: GradientStop) => void
  add: () => void
  remove: () => void
  applyPreset: (gradient: CustomGradient) => void
  canAdd: boolean
  canRemove: boolean
} {
  const [selected, setSelected] = useState(0)
  const active = Math.min(selected, value.stops.length - 1)
  return {
    active,
    select: setSelected,
    setStop: (i, stop) =>
      onChange({ ...value, stops: value.stops.map((st, j) => (j === i ? stop : st)) }),
    add: () => {
      const next = addedStop(value, active)
      if (!next) return
      onChange(next)
      setSelected(value.stops.length)
    },
    remove: () => {
      const next = withoutStop(value, active)
      if (!next) return
      onChange(next)
      setSelected(Math.max(0, active - 1))
    },
    applyPreset: (gradient) => {
      onChange(gradient)
      setSelected(0)
    },
    canAdd: value.stops.length < MAX_GRADIENT_STOPS,
    canRemove: value.stops.length > 1
  }
}
