import { useEffect } from 'react'
import {
  revealSidebar,
  toggleSidebar,
  tuckSidebar,
  useSidebarView
} from '@/components/shell/sidebar-state'
import { isSwitcherOpen } from '@/components/shell/switcher-state'
import { isModKey } from '@/lib/mod-key'
import { HIDE_DELAY_MS, canHide, holdsOf, inHotZone } from '@/lib/sidebar-reveal'
import { useDialogStore } from '@/stores/dialogStore'

/** ⌘S (Ctrl S) toggles the sidebar. Neither the composer nor the page editor binds it. */
export function useSidebarShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 's' || !isModKey(e)) return
      e.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * N3, the hidden sidebar: the pointer in the left 8 px reveals it; it hides 300 ms after the
 * pointer leaves `ref`, but not while a menu, a drag, a focused text field in it or the quick
 * switcher holds it. Esc hides it; a dialog closes it first.
 */
export function useSidebarReveal(ref: React.RefObject<HTMLElement | null>): void {
  const view = useSidebarView()

  useEffect(() => {
    if (view !== 'tucked') return
    const onMove = (e: PointerEvent): void => {
      if (!inHotZone(e.clientX) || useDialogStore.getState().dialog !== null) return
      revealSidebar()
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [view])

  // A dialog opens above everything: a revealed sidebar closes first.
  useEffect(
    () =>
      useDialogStore.subscribe((s) => {
        if (s.dialog !== null) tuckSidebar()
      }),
    []
  )

  // Hide after the pointer leaves; Esc hides.
  useEffect(() => {
    const el = ref.current
    if (view !== 'revealed' || !el) return
    // The sidebar slides in under the pointer: it counts as inside until the first leave.
    let inside = true
    let dragging = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const held = (): boolean => isSwitcherOpen() || !canHide(holdsOf(el, dragging))
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (inside) return
        if (held()) schedule()
        else tuckSidebar()
      }, HIDE_DELAY_MS)
    }
    const onEnter = (): void => {
      inside = true
      clearTimeout(timer)
    }
    const onLeave = (): void => {
      inside = false
      schedule()
    }
    const onDown = (): void => {
      dragging = true
    }
    const onUp = (): void => {
      dragging = false
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const h = holdsOf(el, dragging)
      if (!h.menuOpen && !h.dragging && !isSwitcherOpen()) tuckSidebar()
    }
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, view])
}
