/**
 * Colour marks the feature (docs/ui-redesign.md §1). The class names are full literals so that
 * Tailwind finds them.
 */
export type Feature = 'accent' | 'voice' | 'event' | 'page' | 'thread' | 'danger' | 'bot'

/** Text and icon colour of the feature. */
export const FEATURE_TEXT: Record<Feature, string> = {
  accent: 'text-accent-text',
  voice: 'text-feature-voice-text',
  event: 'text-feature-event-text',
  page: 'text-feature-page-text',
  thread: 'text-feature-thread-text',
  danger: 'text-feature-danger-text',
  bot: 'text-feature-bot'
}

/** Tinted tile: a light wash of the feature colour with the feature-coloured icon. */
export const FEATURE_TILE: Record<Feature, string> = {
  accent: 'bg-accent-tint text-accent-text',
  voice: 'bg-feature-voice/15 text-feature-voice-text',
  event: 'bg-feature-event/15 text-feature-event-text',
  page: 'bg-feature-page/15 text-feature-page-text',
  thread: 'bg-feature-thread/15 text-feature-thread-text',
  danger: 'bg-feature-danger/15 text-feature-danger-text',
  bot: 'bg-feature-bot/15 text-feature-bot'
}

/** Border of a selected option in the feature colour. */
export const FEATURE_BORDER: Record<Feature, string> = {
  accent: 'border-accent-primary',
  voice: 'border-feature-voice',
  event: 'border-feature-event',
  page: 'border-feature-page',
  thread: 'border-feature-thread',
  danger: 'border-feature-danger',
  bot: 'border-feature-bot'
}
