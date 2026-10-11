// The `?preview` launch flags, parsed in one place for every host that offers preview mode.
import type { Theme } from '@/stores/prefsStore'

export interface PreviewOptions {
  /** Show the signed-out screen instead of the seeded app. */
  signedOut?: boolean
  /** Force the transcript display mode. */
  messageDisplay?: 'cozy' | 'compact'
  /** Force the theme; preview defaults to dark so screenshots are stable. */
  theme?: Theme
}

/** `?preview`, `?preview=signedout`, `&theme=light|system`, `&display=compact|cozy`. */
export function previewOptionsFromQuery(q: URLSearchParams): PreviewOptions {
  const theme = q.get('theme')
  const display = q.get('display')
  return {
    signedOut: q.get('preview') === 'signedout',
    theme: theme === 'light' || theme === 'system' ? theme : undefined,
    messageDisplay: display === 'compact' || display === 'cozy' ? display : undefined
  }
}
