/**
 * A touch target of 36 around a smaller control on the mobile layout (spec §2.10): an invisible
 * square centred on it. The control keeps its look.
 */
export const TOUCH_HIT =
  'mobile:relative mobile:after:absolute mobile:after:top-1/2 mobile:after:left-1/2 mobile:after:size-9 mobile:after:-translate-1/2'

/** A 36 high touch band across a short control's full width on the mobile layout (spec §2.10). */
export const TOUCH_HIT_BAND =
  'mobile:relative mobile:after:absolute mobile:after:inset-x-0 mobile:after:top-1/2 mobile:after:h-9 mobile:after:-translate-y-1/2'
