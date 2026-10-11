import { useEffect, useState } from 'react'
import { Pin } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAction } from '@/hooks/use-action'
import { pinsService } from '@/services/guild-features'
import { usePinCount, usePins } from '@/stores/pinsStore'
import { EmptyLine, HeaderCountButton, HeaderPopoverFrame } from './header-count-button'
import { jumpToMessage } from '@/lib/navigation'
import { MessagePreview } from './message-preview'
import { useCanPin } from './use-can-pin'

/**
 * The amber pin button of the channel header (N13) and its popover of pinned messages. On the
 * mobile layout the popover is a sheet.
 */
export function PinsButton({ channel }: { channel: Channel }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const count = usePinCount(channel.id)

  useEffect(() => {
    pinsService.ensureLoaded(channel.id)
  }, [channel.id])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <HeaderCountButton
          label="Pinned messages"
          count={count ?? 0}
          feature="event"
          pressed={open}
          className={(count ?? 0) > 0 ? 'mobile:bg-feature-event/9' : undefined}
        >
          <Pin />
        </HeaderCountButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[480px] max-w-[calc(100vw-32px)] p-0">
        <PinsList channel={channel} loaded={count !== null} onJump={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function PinsList({
  channel,
  loaded,
  onJump
}: {
  channel: Channel
  loaded: boolean
  onJump: () => void
}): React.JSX.Element {
  const pins = usePins(channel.id)
  const canUnpin = useCanPin(channel)
  const { run, busy, error } = useAction()

  return (
    <HeaderPopoverFrame icon={<Pin className="text-feature-event-text" />} title="Pinned messages">
      {!loaded ? (
        <EmptyLine>Loading pins…</EmptyLine>
      ) : pins.length === 0 ? (
        <EmptyLine>No pinned messages yet. Pin one from its “More” menu.</EmptyLine>
      ) : (
        pins.map((m) => (
          <MessagePreview
            key={m.id}
            message={m}
            actions={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mobile:h-9"
                  onClick={() => {
                    onJump()
                    jumpToMessage(channel, m.id)
                  }}
                >
                  Jump
                </Button>
                {canUnpin && (
                  <Button
                    variant="quiet"
                    size="sm"
                    className="mobile:h-9"
                    disabled={busy}
                    onClick={() => void run('unpin', () => pinsService.unpin(channel.id, m.id))}
                  >
                    Unpin
                  </Button>
                )}
              </>
            }
          />
        ))
      )}
      <div className="px-2.5">
        <ErrorText>{error}</ErrorText>
      </div>
    </HeaderPopoverFrame>
  )
}
