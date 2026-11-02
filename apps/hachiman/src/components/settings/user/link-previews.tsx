import { ToggleRow } from '@/components/settings/user/rows'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

const HINT =
  'When you send a link, this device opens the page and adds a preview to the encrypted message. The site sees your IP address. Others never open the link to make it.'

/**
 * The link previews switch (§12.8.1, `prefsStore.linkPreviews`) as a row, or null where the host
 * cannot fetch a page (the browser): there, previews come only from other devices. The row is
 * the same on both layouts.
 */
export function LinkPreviewSetting(): React.JSX.Element | null {
  const canFetch = usePlatform().fetchLinkResource !== null
  const on = usePrefsStore((s) => s.linkPreviews)
  const setOn = usePrefsStore((s) => s.setLinkPreviews)
  if (!canFetch) return null
  return <ToggleRow title="Load link previews" hint={HINT} checked={on} onChange={setOn} />
}
