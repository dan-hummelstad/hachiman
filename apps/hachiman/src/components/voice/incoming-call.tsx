import { Phone, PhoneOff } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { useMemberView } from '@/hooks/use-member'
import { channelLabel } from '@/lib/model'
import { callRingService } from '@/services/CallRingService'
import { useChannelStore } from '@/stores/channelStore'
import { useRingStore } from '@/stores/ringStore'

/**
 * The incoming DM call card (§6 "DM calls"), on top of the app while the call rings: the caller,
 * Decline (stops the ring on this device) and Accept (joins the call and opens the DM).
 */
export function IncomingCall(): React.JSX.Element | null {
  const ring = useRingStore((s) => s.ring)
  const channel = useChannelStore((s) => (ring ? s.channels.get(ring.channelId) : undefined))
  const { name, avatar } = useMemberView(null, ring?.callerId ?? '')
  if (!ring || !channel) return null
  const group = (channel.recipients?.length ?? 0) > 1

  return (
    <div
      role="alertdialog"
      aria-label={`Incoming call from ${name}`}
      className="bg-surface-raised border-line-hairline fixed top-4 left-1/2 z-50 flex w-[min(360px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 border p-3 shadow-xl"
    >
      <UserAvatar name={name} avatar={avatar} size={40} cutout="bg-surface-raised" />
      <div className="min-w-0 flex-1">
        <p className="text-text-primary truncate text-sm font-extrabold">{name}</p>
        <p className="text-text-tertiary truncate text-xs">
          {group ? `Incoming call · ${channelLabel(channel).name}` : 'Incoming call'}
        </p>
      </div>
      <Button
        variant="danger"
        size="icon"
        aria-label="Decline"
        title="Decline"
        onClick={() => callRingService.decline()}
      >
        <PhoneOff />
      </Button>
      <Button
        variant="voice"
        size="icon"
        aria-label="Accept"
        title="Accept"
        onClick={() => callRingService.accept()}
      >
        <Phone />
      </Button>
    </div>
  )
}
