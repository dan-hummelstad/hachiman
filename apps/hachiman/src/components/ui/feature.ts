/**
 * Colour answers three questions: `here` (accent), `live` (voice) and `you` (danger). The other
 * features are neutral. The class names are full literals so that Tailwind finds them.
 */
export type Feature = 'accent' | 'voice' | 'event' | 'page' | 'thread' | 'danger' | 'bot'

/** Text and icon colour of the feature. */
export const FEATURE_TEXT: Record<Feature, string> = {
  accent: 'text-here-text',
  voice: 'text-live-text',
  event: 'text-text-secondary',
  page: 'text-text-secondary',
  thread: 'text-text-secondary',
  danger: 'text-you-text',
  bot: 'text-text-secondary'
}

/** Tinted tile: a light wash of the feature colour with the feature-coloured icon. */
export const FEATURE_TILE: Record<Feature, string> = {
  accent: 'bg-here-tint text-here-text',
  voice: 'bg-live-tint text-live-text',
  event: 'bg-surface-raised text-text-secondary',
  page: 'bg-surface-raised text-text-secondary',
  thread: 'bg-surface-raised text-text-secondary',
  danger: 'bg-you-tint text-you-text',
  bot: 'bg-surface-raised text-text-secondary'
}

/** Border of a selected option in the feature colour. */
export const FEATURE_BORDER: Record<Feature, string> = {
  accent: 'border-here',
  voice: 'border-live',
  event: 'border-line-strong',
  page: 'border-line-strong',
  thread: 'border-line-strong',
  danger: 'border-you',
  bot: 'border-line-strong'
}
