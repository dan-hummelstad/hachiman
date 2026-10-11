import { useEffect, useRef, useState } from 'react'
import { addedStop, clampSelected, withoutStop, type StopEdit } from '@/lib/gradient-pad'
import { MAX_GRADIENT_STOPS, type CustomGradient, type GradientStop } from '@/lib/guild-tint'

/**
 * The state of a gradient editor (desktop `GradientPicker`, phone `GradientPickerMobile`): the
 * selected stop, and the edits of `value` through `onChange`. A drag of a stop, the lightness or
 * the angle sends at most one change per frame, so the store, its persisted copy and the native
 * appearance do not update on every pointer move.
 */
export function useGradientEditor(
  value: CustomGradient,
  onChange: (value: CustomGradient) => void
): {
  active: number
  select: (i: number) => void
  setStop: (i: number, stop: GradientStop) => void
  setLightness: (lightness: number) => void
  setAngle: (angle: number) => void
  add: () => void
  remove: () => void
  applyPreset: (gradient: CustomGradient) => void
  canAdd: boolean
  canRemove: boolean
} {
  const [selected, setSelected] = useState(0)
  const active = clampSelected(selected, value.stops.length)
  const pending = useRef<CustomGradient | null>(null)
  const frame = useRef(0)

  // Send a change that is still waiting when the editor goes away.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      const last = pending.current
      pending.current = null
      if (last) onChange(last)
    },
    [onChange]
  )

  const latest = (): CustomGradient => pending.current ?? value
  const live = (next: CustomGradient): void => {
    pending.current = next
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const last = pending.current
      pending.current = null
      if (last) onChange(last)
    })
  }
  const now = (next: CustomGradient): void => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    pending.current = null
    onChange(next)
  }
  const edit = (next: StopEdit | null): void => {
    if (!next) return
    now(next.value)
    setSelected(next.selected)
  }

  return {
    active,
    select: setSelected,
    setStop: (i, stop) => {
      const v = latest()
      live({ ...v, stops: v.stops.map((st, j) => (j === i ? stop : st)) })
    },
    setLightness: (lightness) => live({ ...latest(), lightness }),
    setAngle: (angle) => live({ ...latest(), angle }),
    add: () => edit(addedStop(latest(), active)),
    remove: () => edit(withoutStop(latest(), active)),
    applyPreset: (gradient) => {
      now(gradient)
      setSelected(0)
    },
    canAdd: value.stops.length < MAX_GRADIENT_STOPS,
    canRemove: value.stops.length > 1
  }
}
