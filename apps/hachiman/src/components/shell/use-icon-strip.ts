import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { stripFit, stripSlots } from '@/lib/icon-strip'

/** Every focusable item of a strip carries this attribute: the arrow keys move between them. */
export const STRIP_ITEM = { 'data-strip-item': '' } as const

export interface IconStrip {
  /** The items to show: the ones that fit, or all of them when expanded. */
  shown: string[]
  /** The items that do not fit (the glyph and the badge of the "more" item). */
  hidden: string[]
  /** True when the strip shows the "more" item (not everything fits, or it is expanded). */
  more: boolean
  /** True when the tail shows (everything fits, or it is expanded). */
  tail: boolean
  expanded: boolean
  /** Props of the "more" item: it toggles the grid. */
  moreProps: {
    'data-strip-more': ''
    'aria-expanded': boolean
    onClick: () => void
  } & typeof STRIP_ITEM
  /** The keydown handler of the strip box: arrow keys, Home and End move the focus. */
  onKeyDown: (e: React.KeyboardEvent) => void
}

/**
 * A one-line icon strip with a final "more" item that expands it in place into a grid of all the
 * items (the space bar, the favourite DMs). `fixed`: the leading items that always show (the
 * space bar's avatar and DM home). `tail`: a last item that shows only when everything fits.
 * The grid collapses on Escape, on a click outside the strip, and when `selected` changes.
 */
export function useIconStrip({
  ids,
  selected,
  size,
  gap,
  fixed = 0,
  tail = false
}: {
  ids: readonly string[]
  selected: string | null | undefined
  size: number
  gap: number
  fixed?: number
  tail?: boolean
}): [attach: (el: HTMLElement | null) => void, strip: IconStrip] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [lastSelected, setLastSelected] = useState(selected)

  if (lastSelected !== selected) {
    setLastSelected(selected)
    setExpanded(false)
  }

  useLayoutEffect(() => {
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])

  useEffect(() => {
    if (!expanded || !el) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!el.contains(e.target as Node)) setExpanded(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      // An open menu takes its Escape first. Prevented: a revealed sidebar stays (it checks).
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"]')) {
        return
      }
      e.preventDefault()
      if (el.contains(document.activeElement)) {
        el.querySelector<HTMLElement>('[data-strip-more]')?.focus()
      }
      setExpanded(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded, el])

  const columns = stripSlots(width, size, gap)
  const fit = useMemo(
    () => stripFit(ids, columns - fixed, selected, tail),
    [ids, columns, fixed, selected, tail]
  )

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!el) return
    const items = [...el.querySelectorAll<HTMLElement>('[data-strip-item]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns,
      ArrowDown: columns,
      Home: -at,
      End: items.length - 1 - at
    }
    const d = step[e.key]
    if (d === undefined) return
    const next = items[Math.min(items.length - 1, Math.max(0, at + d))]
    e.preventDefault()
    next?.focus()
  }

  const strip: IconStrip = {
    shown: expanded ? [...ids] : fit.shown,
    hidden: expanded ? [] : fit.hidden,
    more: expanded || fit.more,
    tail: tail && (expanded || !fit.more),
    expanded,
    moreProps: {
      'data-strip-more': '',
      'aria-expanded': expanded,
      onClick: () => setExpanded((v) => !v),
      ...STRIP_ITEM
    },
    onKeyDown
  }
  // The ref callback of the strip box: its content width sets how many items fit.
  return [setEl, strip]
}
