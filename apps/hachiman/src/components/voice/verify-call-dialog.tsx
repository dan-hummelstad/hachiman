import { useCallback, useEffect, useState } from 'react'
import { Check, LoaderCircle, LogOut, ShieldCheck, TriangleAlert } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ModalWindow } from '@/components/ui/modal-window'
import { CallSecurityBanner } from '@/components/voice/call-security'
import { epochCodeGroups, type CallParticipant } from '@/components/voice/call-roster'
import {
  useCallParticipants,
  useCallSecurity,
  useEpochCode
} from '@/components/voice/use-call-security'
import { TRUST_LOOK } from '@/components/people/trust-look'
import { useContactTrust } from '@/components/people/use-contact-trust'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog, useDialog, useDialogStore } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * "Verify call" (dialog kind 'verifyCall'): the epoch code of the active epoch (§12.5) and the
 * participants from the MLS tree (§12.10.1), each with a link to their safety number. The code
 * changes on each epoch, so it is compared again after each join or leave.
 *
 * On the mobile layout it is the M65 sheet. Its body scrolls as a whole, and "Safety number"
 * shows M9 in its place; when M9 closes, this sheet comes back.
 */
export function VerifyCallDialog(): React.JSX.Element {
  const { open, close } = useDialog('verifyCall')
  const mobile = useLayout() === 'mobile'
  const returnAfterVerification = useReturnAfterVerification()
  const guildId = useVoiceStore((s) => s.guildId)
  const channelId = useVoiceStore((s) => s.channelId)
  const channelName = useChannelStore((s) =>
    channelId ? (s.channels.get(channelId)?.name ?? null) : null
  )
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))
  const participants = useCallParticipants(guildId, channelId ?? '')
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
        <CallDetails
          guildId={guildId}
          participants={participants ?? []}
          onSafetyNumber={(userId) => {
            if (mobile) returnAfterVerification()
            openDialog({ kind: 'verification', userId })
          }}
        />
      ) : (
        <p className="text-text-secondary text-sm">You are not in a call.</p>
      )}
    </ModalWindow>
  )
}

/**
 * Mobile: "Safety number" puts M9 in the place of this sheet (one dialog at a time). The function
 * that this returns, called with that open, opens this sheet again once M9 closes and I am still
 * in a call. Another dialog that replaces M9 ends the return. This instance stays mounted while
 * M9 shows (`Dialogs` keeps the last one of each kind).
 */
function useReturnAfterVerification(): () => void {
  const [returning, setReturning] = useState(false)
  useEffect(() => {
    if (!returning) return
    return useDialogStore.subscribe((s) => {
      if (s.dialog?.kind === 'verification') return
      setReturning(false)
      if (s.dialog !== null) return
      // After this store update has reached every listener, and only if nothing opened since.
      queueMicrotask(() => {
        const idle = useDialogStore.getState().dialog === null
        if (idle && useVoiceStore.getState().channelId !== null) openDialog({ kind: 'verifyCall' })
      })
    })
  }, [returning])
  return useCallback(() => setReturning(true), [])
}

/**
 * The text that the live region of the mobile sheet reads when the call code changes while it is
 * open (a join or a leave): the new code, so that a screen reader user can compare it again. Empty for
 * the first code.
 */
function useCodeChangeNotice(code: string | null): string {
  const [seen, setSeen] = useState({ code, notice: '' })
  if (code !== null && code !== seen.code) {
    setSeen({
      code,
      notice: seen.code === null ? '' : `The call code changed. The new code is ${code}.`
    })
  }
  return seen.notice
}

function CallDetails({
  guildId,
  participants,
  onSafetyNumber
}: {
  guildId: string
  participants: CallParticipant[]
  onSafetyNumber: (userId: string) => void
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { kind } = useCallSecurity()
  const groups = epochCodeGroups(useEpochCode())
  const shown = kind === 'secure' ? groups : null
  const notice = useCodeChangeNotice(shown ? shown.join(' ') : null)
  const meId = useUserStore((s) => s.me?.id ?? null)
  const inTree = participants.filter((p) => p.status !== 'joining')
  const joining = participants.filter((p) => p.status === 'joining')

  return (
    // Mobile: no inner scroller, the sheet body scrolls (M65).
    <div className="mobile:mx-0 mobile:max-h-none mobile:space-y-3.5 mobile:overflow-visible mobile:px-0 -mx-[22px] max-h-[60vh] space-y-4 overflow-y-auto px-[22px]">
      <CallSecurityBanner />
      <p className="text-text-secondary mobile:text-[15px] mobile:leading-normal mobile:font-medium text-sm">
        Everyone in this call sees the same code. Read it out loud and check that it matches.
      </p>
      <section
        aria-label="Call code"
        className="bg-surface-sunken border-line-hairline mobile:space-y-2.5 mobile:px-[18px] mobile:pt-3.5 mobile:pb-4 space-y-2 border px-4 py-3"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="section-label">Call code</span>
          <span className="text-text-tertiary mobile:font-medium text-xs">
            Changes when someone joins
          </span>
        </div>
        {/* Mobile only: the desktop dialog does not change (spec 6.1). */}
        {mobile && (
          <p role="status" className="sr-only">
            {notice}
          </p>
        )}
        {shown ? (
          <div className="text-text-primary mobile:grid-cols-[repeat(3,auto)] mobile:justify-between mobile:gap-x-0 mobile:tracking-[1px] grid grid-cols-3 gap-x-6 gap-y-1 font-mono text-[26px] leading-9 font-semibold tracking-wide tabular-nums">
            {shown.map((g, i) => (
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
      <Callout
        tone="caution"
        icon={mobile ? <TriangleAlert /> : undefined}
        className="mobile:py-[11px] mobile:text-[13.5px] mobile:leading-[1.45]"
      >
        If anyone sees a different code, do not continue. Leave the call and join again.
      </Callout>

      <section aria-label="In the encrypted call" className="space-y-2">
        <p className={SECTION_LABEL}>In the encrypted call · {inTree.length}</p>
        {inTree.length > 0 ? (
          <ParticipantList
            guildId={guildId}
            participants={inTree}
            meId={meId}
            onSafetyNumber={onSafetyNumber}
          />
        ) : (
          <p className="text-text-tertiary text-sm">No one has the call keys yet.</p>
        )}
      </section>
      {joining.length > 0 && (
        <section aria-label="Joining" className="space-y-2">
          <p className={cn(SECTION_LABEL, 'mobile:text-feature-event-text')}>
            Joining · {joining.length}
          </p>
          <ParticipantList
            guildId={guildId}
            participants={joining}
            meId={meId}
            onSafetyNumber={onSafetyNumber}
            tone="joining"
          />
          <p className="text-text-tertiary mobile:text-[12.5px] mobile:leading-[1.45] mobile:font-medium text-xs">
            People who are still joining cannot hear or see the call until they have the keys.
          </p>
        </section>
      )}
    </div>
  )
}

/** The section label; on the mobile layout the kit's Section Label (padding 4/4/0/4). */
const SECTION_LABEL = 'section-label mobile:px-1 mobile:pt-1'

/** Mobile: a list group with hairline rows (M65); the joining group in gold. */
const LIST_TONE = {
  tree: 'mobile:bg-white/2',
  joining: 'mobile:bg-feature-event/3 mobile:border-feature-event/14 mobile:divide-feature-event/14'
} as const

function ParticipantList({
  guildId,
  participants,
  meId,
  onSafetyNumber,
  tone = 'tree'
}: {
  guildId: string
  participants: CallParticipant[]
  meId: string | null
  onSafetyNumber: (userId: string) => void
  tone?: keyof typeof LIST_TONE
}): React.JSX.Element {
  return (
    <ul
      className={cn(
        'border-line-hairline mobile:divide-y mobile:divide-line-hairline mobile:py-0 border py-1',
        LIST_TONE[tone]
      )}
    >
      {participants.map((p) => (
        <ParticipantRow
          key={p.userId}
          guildId={guildId}
          participant={p}
          self={p.userId === meId}
          onSafetyNumber={onSafetyNumber}
        />
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

/** Row of M65: 50 high, avatar 32, name 15/700, the key state 12.5/700. */
function ParticipantRow({
  guildId,
  participant,
  self,
  onSafetyNumber
}: {
  guildId: string
  participant: CallParticipant
  self: boolean
  onSafetyNumber: (userId: string) => void
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { name, ink, avatar } = useMemberView(guildId, participant.userId)
  const devices = participant.leaves.length
  const status = STATUS[participant.status]

  return (
    <li className="mobile:min-h-[50px] mobile:py-1.5 mobile:pr-2 mobile:pl-3 flex items-center gap-3 px-3 py-2">
      <UserAvatar name={name} avatar={avatar} color={ink} size={mobile ? 32 : 28} />
      <div className="mobile:gap-0.5 flex min-w-0 flex-1 flex-col">
        <span className="mobile:gap-[5px] mobile:text-[15px] flex min-w-0 items-center gap-1 text-sm">
          <span className="truncate font-bold" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          {self && (
            <span className="text-text-tertiary mobile:text-[12.5px] mobile:font-semibold">
              (you)
            </span>
          )}
          {!self && <TrustMark userId={participant.userId} />}
        </span>
        <span
          className={cn(
            'mobile:text-[12.5px] mobile:font-bold mobile:min-w-0 flex items-center gap-1 text-xs font-semibold [&_svg]:size-3 [&_svg]:shrink-0',
            status.className
          )}
        >
          {status.icon}
          {/* One line on the SE too: the row stays 50 high. */}
          <span className="mobile:truncate">{status.text}</span>
        </span>
        {devices > 1 && (
          <span className="text-feature-event-text mobile:text-[12.5px] text-xs">
            {devices} devices in the call group
          </span>
        )}
      </div>
      {!self && (
        <Button
          variant="secondary"
          size="sm"
          className="mobile:h-9 mobile:border-line-strong mobile:bg-fill-control mobile:px-3 mobile:font-bold"
          onClick={() => onSafetyNumber(participant.userId)}
        >
          Safety number
        </Button>
      )}
    </li>
  )
}

function TrustMark({ userId }: { userId: string }): React.JSX.Element | null {
  const { trust } = useContactTrust(userId)
  if (trust?.state !== 'verified' && trust?.state !== 'changed') return null
  const look = TRUST_LOOK[trust.state]
  return (
    <look.Icon className={cn(look.text, 'size-3.5 shrink-0')} aria-label={look.label} role="img" />
  )
}
