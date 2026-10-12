import { useMediaQuery } from '@/hooks/use-media-query'
import { usePlatform } from '@/shared/PlatformContext'

/** The shell form (docs/ios-mobile-ui-spec.md §2.2). `App.tsx` writes it to `<html data-layout>`. */
export type Layout = 'desktop' | 'mobile'

/** Phone width (below Tailwind's `md`). */
export const NARROW_QUERY = '(max-width: 767px)'
/** A phone in landscape in the browser host. */
export const SHORT_TOUCH_QUERY = '(pointer: coarse) and (max-height: 500px)'

export function layoutOf(facts: { ios: boolean; narrow: boolean; shortTouch: boolean }): Layout {
  return facts.ios || facts.narrow || facts.shortTouch ? 'mobile' : 'desktop'
}

export function useLayout(): Layout {
  const ios = usePlatform().platform === 'ios'
  const narrow = useMediaQuery(NARROW_QUERY)
  const shortTouch = useMediaQuery(SHORT_TOUCH_QUERY)
  return layoutOf({ ios, narrow, shortTouch })
}

/**
 * The layout for code outside React: the value that `App.tsx` wrote on `<html>`. Before the
 * first commit of `App` there is none, and only the media queries count.
 */
export function layoutNow(): Layout {
  const written = document.documentElement.dataset.layout
  if (written === 'mobile' || written === 'desktop') return written
  return layoutOf({
    ios: false,
    narrow: window.matchMedia(NARROW_QUERY).matches,
    shortTouch: window.matchMedia(SHORT_TOUCH_QUERY).matches
  })
}
