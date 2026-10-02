import { BadgeCheck, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalWindow } from '@/components/ui/modal-window'
import { CallSecurityBanner } from '@/components/voice/call-security'
import { epochCodeGroups, type CallParticipant } from '@/components/voice/call-roster'
import {
  useCallParticipants,
  useCallSecurity,
  useEpochCode,
  useTrust
} from '@/components/voice/use-call-security'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * "Verify call" (dialog kind 'verifyCall'): the epoch code of the active epoch (§12.5) and the
 * participants from the MLS tree (§12.10.1), each with a link to their safety number. The code
 * changes on each epoch, so it is compared again after each join or leave.
 */
export function VerifyCallDialog(): React.JSX.Element {
  const { open, close } = useDialog('verifyCall')
  const guildId = useVoiceStore((s) => s.guildId)
  const channelId = useVoiceStore((s) => s.channelId)

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title="Verify call"
      description="All people in this call see the same code. Compare it with them by voice."
      actions={
        <Button variant="ghost" onClick={close}>
          Done
        </Button>
      }
    >
      {guildId && channelId ? (
        <CallDetails guildId={guildId} channelId={channelId} />
      ) : (
        <p className="text-muted-foreground text-sm">You are not in a call.</p>
      )}
    </ModalWindow>
  )
}

function CallDetails({
  guildId,
  channelId
}: {
  guildId: string
  channelId: string
}): React.JSX.Element {
  const { kind, epoch } = useCallSecurity()
  const groups = epochCodeGroups(useEpochCode())
  const participants = useCallParticipants(guildId, channelId) ?? []
  const meId = useUserStore((s) => s.me?.id ?? null)
  const inTree = participants.filter((p) => p.status !== 'joining')
  const joining = participants.filter((p) => p.status === 'joining')

  return (
    <div className="space-y-4">
      <CallSecurityBanner />
      <section aria-label="Epoch code" className="space-y-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-semibold">Call code</span>
          {kind === 'secure' && <span className="text-muted-foreground">Epoch {epoch}</span>}
        </div>
        {kind === 'secure' && groups ? (
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 border px-3 py-2 font-mono text-lg tabular-nums">
            {groups.map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground border px-3 py-2 text-sm">
            {kind === 'secure' ? 'Reading the code…' : 'The code shows when encryption is ready.'}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          If a person sees a different code, do not continue. Leave the call and join again.
        </p>
      </section>

      <section aria-label="Participants" className="space-y-1.5">
        <p className="text-xs font-semibold">In the encrypted call</p>
        {inTree.length > 0 ? (
          <ul className="divide-y border">
            {inTree.map((p) => (
              <ParticipantRow
                key={p.userId}
                guildId={guildId}
                participant={p}
                self={p.userId === meId}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No one has the call keys yet.</p>
        )}
        {joining.length > 0 && (
          <>
            <p className="pt-2 text-xs font-semibold">Joining</p>
            <ul className="divide-y border">
              {joining.map((p) => (
                <ParticipantRow
                  key={p.userId}
                  guildId={guildId}
                  participant={p}
                  self={p.userId === meId}
                />
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              These people do not have the call keys yet. You cannot hear or see them until they do.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

const STATUS_NOTE: Record<CallParticipant['status'], string | null> = {
  secure: null,
  joining: 'Waiting for the call keys',
  leaving: 'Left the call. Has the keys until the group removes them'
}

function ParticipantRow({
  guildId,
  participant,
  self
}: {
  guildId: string
  participant: CallParticipant
  self: boolean
}): React.JSX.Element {
  const { name, ink } = useMemberView(guildId, participant.userId)
  const devices = participant.leaves.length
  const note = STATUS_NOTE[participant.status]

  return (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-medium" style={ink ? { color: ink } : undefined}>
            {self ? `${name} (you)` : name}
          </span>
          {!self && <TrustMark userId={participant.userId} />}
        </span>
        {(note || devices > 1) && (
          <span
            className={cn(
              'text-xs',
              devices > 1 || participant.status === 'leaving'
                ? 'text-idle'
                : 'text-muted-foreground'
            )}
          >
            {[note, devices > 1 ? `${devices} devices in the call group` : null]
              .filter(Boolean)
              .join('. ')}
          </span>
        )}
      </div>
      {!self && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => openDialog({ kind: 'verification', userId: participant.userId })}
        >
          Safety number
        </Button>
      )}
    </li>
  )
}

function TrustMark({ userId }: { userId: string }): React.JSX.Element | null {
  const trust = useTrust(userId)
  if (trust?.state === 'verified')
    return <BadgeCheck className="text-online size-3.5 shrink-0" aria-label="Verified" role="img" />
  if (trust?.state === 'changed')
    return (
      <ShieldAlert className="text-dnd size-3.5 shrink-0" aria-label="Key changed" role="img" />
    )
  return null
}
