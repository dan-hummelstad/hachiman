import { PagesPanel } from '@/components/docs/pages-panel'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { useLatched } from '@/hooks/use-latched'
import { pageTitle } from '@/services/docs/page-tree'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { navigate, useCurrentView } from '@/stores/navStore'

/**
 * The full-screen page of a `{ kind: 'page' }` view (docs/ios-mobile-ui-spec.md §2.6), pushed over
 * the chat of its pages channel. For now the desktop `PagesPanel`. Back goes to the channel's
 * chat, which clears the open page.
 */
export function PageScreen(): React.JSX.Element | null {
  const view = useCurrentView()
  const page = view.kind === 'page' ? view : null
  // The last page stays while the screen slides out.
  const shown = useLatched(page)
  const channel = useChannelStore((s) => (shown ? s.channels.get(shown.channelId) : undefined))
  const guildName = useGuildStore((s) => (shown ? s.guilds.get(shown.guildId)?.name : undefined))
  const node = useDocsStore((s) =>
    shown ? s.pagesByChannel.get(shown.channelId)?.find((p) => p.id === shown.pageId) : undefined
  )
  if (!shown || !channel) return null

  const back = (): void =>
    navigate({ kind: 'channel', guildId: shown.guildId, channelId: shown.channelId })
  const where = guildName ? `#${channel.name ?? ''} · ${guildName}` : `#${channel.name ?? ''}`

  return (
    <PushedScreen
      open={page !== null}
      title={node ? pageTitle(node) : 'Page'}
      subtitle={where}
      onBack={back}
      backLabel="Back to the chat"
      bodyClassName="gap-0 overflow-hidden p-0 pb-(--safe-bottom) in-data-[keyboard=open]:pb-0"
    >
      <PagesPanel channel={channel} />
    </PushedScreen>
  )
}
