import { Ban } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { blockService } from '@/services/guild-features'

/**
 * "Block <name>?" (N23). A block refuses DMs both ways and hides their messages in shared guilds
 * behind "Blocked message". The other user is not told (contract §4).
 */
export function BlockConfirmDialog({
  userId,
  name,
  open,
  onClose
}: {
  userId: string
  name: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Block ${name}?`}
      icon={<Ban />}
      tone="danger"
      confirmLabel="Block"
      what={`block ${name}`}
      body={
        <p className="text-text-secondary">
          {name} can&apos;t send you direct messages, and you can&apos;t send them any. Their
          messages in shared guilds are hidden for you. They are not told.
        </p>
      }
      onConfirm={() => blockService.block(userId)}
    />
  )
}
