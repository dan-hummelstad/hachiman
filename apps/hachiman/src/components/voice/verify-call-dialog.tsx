import { BadgeCheck, Check, LoaderCircle, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
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
import { useChannelStore } from '@/stores/channelStore'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
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
  const channelName = useChannelStore((s) =>
    channelId ? (s.channels.get(channelId)?.name ?? null) : null
  )
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))
  const participants = useCallParticipants(guildId ?? '', channelId ?? '')
  const people = participants?.filter((p) => p.status !== 'leaving').length ?? 0
  const subtitle = [channelName, guildName, `${people} ${people === 1 ? 'person' : 'people'}`]
    .filter((part) => part !== null)
    .join(' · ')

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title="Verify call"
      description={guildId && channelId ? subtitle : undefined}
      icon={<ShieldCheck />}
      feature="voice"
      className="sm:max-w-[520px]"
      actions={<Button onClick={close}>Done</Button>}
    >
      {guildId && channelId ? (
        <CallDetails guildId={guildId} participants={participants ?? []} />
      ) : (
        <p className="text-text-secondary text-sm">You are not in a call.</p>
      )}
    </ModalWindow>
  )
}

function CallDetails({
  guildId,
  participants
}: {
  guildId: string
  participants: CallParticipant[]
}): React.JSX.Element {
  const { kind } = useCallSecurity()
  const groups = epochCodeGroups(useEpochCode())
  const meId = useUserStore((s) => s.me?.id ?? null)
  const inTree = participants.filter((p) => p.status !== 'joining')
  const joining = participants.filter((p) => p.status === 'joining')

  return (
    <div className="-mx-[22px] max-h-[60vh] space-y-4 overflow-y-auto px-[22px]">
      <CallSecurityBanner />
      <p className="text-text-secondary text-sm">
        Everyone in this call sees the same code. Read it out loud and check that it matches.
      </p>
      <section
        aria-label="Call code"
        className="bg-surface-sunken border-line-hairline space-y-2 border px-4 py-3"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="section-label">Call code</span>
          <span className="text-text-tertiary text-xs">Changes when someone joins</span>
        </div>
        {kind === 'secure' && groups ? (
          <div className="text-text-primary grid grid-cols-3 gap-x-6 gap-y-1 font-mono text-[26px] leading-9 font-semibold tracking-wide tabular-nums">
            {groups.map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
        ) : (
          <p className="text-text-tertiary flex items-center gap-1.5 py-2 text-sm">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            {kind === 'secure' ? 'Reading the code…' : 'The code shows when encryption is ready.'}
          </p>
        )}
      </section>
      <Callout tone="caution">
        If anyone sees a different code, do not continue. Leave the call and join again.
      </Callout>

      <section aria-label="In the encrypted call" className="space-y-2">
        <p className="section-label">In the encrypted call · {inTree.length}</p>
        {inTree.length > 0 ? (
          <ParticipantList guildId={guildId} participants={inTree} meId={meId} />
        ) : (
          <p className="text-text-tertiary text-sm">No one has the call keys yet.</p>
        )}
      </section>
      {joining.length > 0 && (
        <section aria-label="Joining" className="space-y-2">
          <p className="section-label">Joining · {joining.length}</p>
          <ParticipantList guildId={guildId} participants={joining} meId={meId} />
          <p className="text-text-tertiary text-xs">
            People who are still joining cannot hear or see the call until they have the keys.
          </p>
        </section>
      )}
    </div>
  )
}

function ParticipantList({
  guildId,
  participants,
  meId
}: {
  guildId: string
  participants: CallParticipant[]
  meId: string | null
}): React.JSX.Element {
  return (
    <ul className="border-line-hairline border py-1">
      {participants.map((p) => (
        <ParticipantRow key={p.userId} guildId={guildId} participant={p} self={p.userId === meId} />
      ))}
    </ul>
  )
}

const STATUS: Record<
  CallParticipant['status'],
  { text: string; className: string; icon: React.ReactNode }
> = {
  secure: {
    text: 'Has the call keys',
    className: 'text-feature-voice-text',
    icon: <Check aria-hidden />
  },
  joining: {
    text: 'Waiting for the call keys…',
    className: 'text-feature-event-text',
    icon: <LoaderCircle className="animate-spin" aria-hidden />
  },
  leaving: {
    text: 'Left the call. Has the keys until the group removes them',
    className: 'text-text-tertiary',
    icon: <LogOut aria-hidden />
  }
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
  const { name, ink, avatar } = useMemberView(guildId, participant.userId)
  const devices = participant.leaves.length
  const status = STATUS[participant.status]

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <UserAvatar name={name} avatar={avatar} color={ink} size={28} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1 text-sm">
          <span className="truncate font-bold" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          {self && <span className="text-text-tertiary">(you)</span>}
          {!self && <TrustMark userId={participant.userId} />}
        </span>
        <span
          className={cn(
            'flex items-center gap-1 text-xs font-semibold [&_svg]:size-3 [&_svg]:shrink-0',
            status.className
          )}
        >
          {status.icon}
          {status.text}
        </span>
        {devices > 1 && (
          <span className="text-feature-event-text text-xs">
            {devices} devices in the call group
          </span>
        )}
      </div>
      {!self && (
        <Button
          variant="secondary"
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
    return (
      <BadgeCheck
        className="text-feature-voice-text size-3.5 shrink-0"
        aria-label="Verified"
        role="img"
      />
    )
  if (trust?.state === 'changed')
    return (
      <ShieldAlert
        className="text-feature-danger-text size-3.5 shrink-0"
        aria-label="Key changed"
        role="img"
      />
    )
  return null
}
