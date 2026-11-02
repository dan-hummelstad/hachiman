import { ToggleRow } from '@/components/settings/user/rows'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

const HINT =
  'When a message with a link comes into view, this device opens the page to show a preview. The site sees your IP address and when you read the message.'

/**
 * The link previews switch (§12.8.1, `prefsStore.linkPreviews`) as a row, or null where the host
 * cannot fetch a page (the browser): there, no previews show. The row is the same on both layouts.
 */
export function LinkPreviewSetting(): React.JSX.Element | null {
  const canFetch = usePlatform().fetchLinkResource !== null
  const on = usePrefsStore((s) => s.linkPreviews)
  const setOn = usePrefsStore((s) => s.setLinkPreviews)
  if (!canFetch) return null
  return <ToggleRow title="Load link previews" hint={HINT} checked={on} onChange={setOn} />
}
