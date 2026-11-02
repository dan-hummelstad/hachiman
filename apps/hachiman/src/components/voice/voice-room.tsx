import { useId, useMemo, useState } from 'react'
import { Ellipsis, Eye, Info, MessageSquareText, PhoneCall, PhoneOff } from 'lucide-react'
import { Permissions, has, type Channel, type VoiceState } from '@hachiman/client'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { MemberSheet } from '@/components/mobile/member-sheet'
import { AvatarRow, UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { useCallMeta } from '@/components/voice-connected-panel'
import { IconButton } from '@/components/ui/icon-button'
import { CallSecurityBanner } from '@/components/voice/call-security'
import { secureUserIds } from '@/components/voice/call-roster'
import { ScreenShareControls } from '@/components/voice/screen-share-controls'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { SoundboardButton } from '@/components/voice/soundboard-button'
import { LiveCard, StreamerName } from '@/components/voice/live-card'
import { StreamGrid } from '@/components/voice/stream-grid'
import { useCallParticipants, useCanJoinVoice } from '@/components/voice/use-call-security'
import { useVoiceRegionName } from '@/components/voice/use-voice-region'
import { VoiceOccupantRow } from '@/components/voice/voice-occupant-row'
import { othersInCallText } from '@/components/voice/voice-occupant-text'
import { ParticipantTile, type TileStatus } from '@/components/voice/voice-tile'
import { CALL_META, mobileStageGrid, stageColumns } from '@/components/voice/voice-tile-styles'
import { useChannelOccupants, usePermissions } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView } from '@/hooks/use-member'
import { channelLabel, displayName, type GuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Body of a voice channel. In the own call: the stage (live screen shares, a tile per person) and
 * the control bar (floating, docked on mobile). Outside it: what happens in the channel and "Join
 * voice". No messages.
 *
 * In the own call, the tiles come from the MLS tree (§12.10.1): a user that only the servers
 * report shows as joining. Outside the call, only the gateway voice states are known.
 */
export function VoiceRoom({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const mobile = useLayout() === 'mobile'
  if (here) return <Stage channel={channel} />
  return mobile ? <NotJoinedMobile channel={channel} /> : <NotJoined channel={channel} />
}

interface Tile {
  userId: string
  state: VoiceState | null
  status: TileStatus
}

/** The columns of `mobileStageGrid`, as full literals for Tailwind. */
const MOBILE_COLUMNS = { 1: 'grid-cols-1', 2: 'grid-cols-2' } as const

/** The tile list: the strip under live streams, else the grid of the layout. */
function tileListClass(streaming: boolean, mobile: boolean, count: number): string {
  if (streaming) return 'mobile:gap-2.5 flex shrink-0 gap-3 overflow-x-auto'
  if (!mobile) return cn('grid min-h-0 flex-1 auto-rows-fr gap-4', stageColumns(count))
  const grid = mobileStageGrid(count)
  return cn(
    'grid gap-3',
    MOBILE_COLUMNS[grid.columns],
    grid.fill ? 'min-h-0 flex-1 auto-rows-fr' : '[&>li]:aspect-square',
    grid.spanLast && '[&>li:last-child]:col-span-2'
  )
}

/**
 * The own call: a guild voice channel, or a DM call (DmCallPanel: above the transcript on
 * desktop, in place of the chat on mobile). On the mobile layout (M10) the stage has at most two
 * columns, square tiles scroll past four people, the controls dock at the foot, and a touch hold
 * on a tile of a guild call opens the member sheet. `onShowChat` (the stage of a mobile DM) adds
 * the way back to the chat. `variant="strip"` is the call above the chat of a DM: a row of faces
 * and a control row, no full stage.
 */
export function Stage({
  channel,
  onShowChat,
  variant = 'room'
}: {
  channel: Channel
  onShowChat?: () => void
  variant?: 'room' | 'strip'
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const meId = useUserStore((s) => s.me?.id ?? null)
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const participants = useCallParticipants(channel.guildId, channel.id)
  const secure = useMemo(() => (participants ? secureUserIds(participants) : null), [participants])
  const [held, setHeld] = useState<{ userId: string; open: boolean } | null>(null)
  const tiles: Tile[] = (participants ?? []).map((p) => ({
    userId: p.userId,
    state: p.voiceState,
    status: p.status
  }))
  const streaming = occupants.some((vs) => vs.selfStream)
  // The member sheet needs a guild: a DM call has no hold.
  const holdGuildId = mobile ? channel.guildId : null
  const onHold =
    holdGuildId !== null ? (userId: string) => setHeld({ userId, open: true }) : undefined
  const strip = variant === 'strip'

  const list = tiles.map((t) => (
    <ParticipantTile
      key={t.userId}
      guildId={channel.guildId}
      userId={t.userId}
      state={t.state}
      status={t.status}
      self={t.userId === meId}
      compact={streaming || strip}
      onHold={onHold}
    />
  ))

  if (strip)
    return (
      <div className="bg-surface-sunken mobile:gap-3 mobile:p-3.5 flex flex-col gap-4 overflow-y-auto p-6">
        <StreamGrid
          guildId={channel.guildId}
          occupants={occupants}
          secure={secure}
          className="max-h-[40vh] flex-none"
        />
        <ul className="mobile:gap-2.5 flex shrink-0 gap-3.5 overflow-x-auto">{list}</ul>
        {mobile ? <MobileStripControls /> : <StripControls />}
        {!mobile && <StripHint />}
        <CallSecurityBanner />
      </div>
    )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="mobile:gap-3 mobile:p-3.5 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <StreamGrid guildId={channel.guildId} occupants={occupants} secure={secure} />
        <ul className={tileListClass(streaming, mobile, tiles.length)}>{list}</ul>
      </div>
      {mobile ? <DockedControls onShowChat={onShowChat} /> : <ControlBar />}
      {holdGuildId !== null && held && (
        <MemberSheet
          key={held.userId}
          guildId={holdGuildId}
          userId={held.userId}
          open={held.open}
          onOpenChange={(open) => setHeld({ userId: held.userId, open })}
        />
      )}
    </div>
  )
}

/**
 * Bar buttons: 44 x 40, hairline outline, 17 px icons. Mute, deafen and the rest stay neutral:
 * none of them is happening. Only sharing is live.
 */
const BAR_BUTTON =
  "h-10 w-11 rounded-control border border-line-hairline text-text-tertiary hover:bg-surface-hover hover:text-text-primary [&_svg:not([class*='size-'])]:size-[17px]"
const BAR_TOGGLE = cn(
  BAR_BUTTON,
  'aria-pressed:bg-surface-selected aria-pressed:border-line-strong aria-pressed:text-text-primary hover:aria-pressed:text-text-primary'
)
const BAR_SHARE = cn(
  BAR_BUTTON,
  'aria-pressed:bg-live-tint aria-pressed:border-live-line aria-pressed:text-live-text hover:aria-pressed:text-live-text'
)

/** The docked control bar of the stage: the call on the left, then mic, deafen, share, soundboard and Leave. */
function ControlBar(): React.JSX.Element {
  const { channelName, guildName, count, pingText } = useCallMeta()
  const meta = [guildName, `${count} connected`, pingText].filter(Boolean).join(' · ')
  return (
    <div className="flex shrink-0 flex-col">
      <CallSecurityBanner className="px-6 pt-3" />
      <div
        role="toolbar"
        aria-label="Call controls"
        className="bg-surface-content border-line-hairline flex h-[84px] shrink-0 items-center gap-2.5 border-t px-6"
      >
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="text-text-primary truncate text-[13.5px] font-semibold">
            {channelName ?? 'Voice'}
          </span>
          <span className={CALL_META}>{meta}</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <SelfVoiceToggles className={BAR_TOGGLE} />
          <ScreenShareControls buttonClassName={BAR_SHARE} />
          <SoundboardButton className={BAR_BUTTON} />
        </div>
        <Button
          variant="danger"
          className="h-10 gap-[7px] px-4 text-[14px] [&_svg]:size-[15px]"
          onClick={() => voiceService.leaveVoice()}
        >
          <PhoneOff />
          Leave
        </Button>
      </div>
    </div>
  )
}

/** The desktop strip's round buttons: 42, raised; toggles turn to ink while on, sharing to live. */
const STRIP_BUTTON =
  "size-[42px] rounded-pill border border-line-hairline bg-surface-raised text-text-secondary hover:text-text-primary [&_svg:not([class*='size-'])]:size-[17px]"
const STRIP_TOGGLE = cn(
  STRIP_BUTTON,
  'aria-pressed:bg-ink aria-pressed:text-on-ink aria-pressed:border-transparent hover:aria-pressed:text-on-ink'
)
const STRIP_SHARE = cn(
  STRIP_BUTTON,
  'aria-pressed:bg-live aria-pressed:text-on-live aria-pressed:border-transparent hover:aria-pressed:text-on-live'
)

/** The control row of the call strip above a DM's chat (desktop). */
function StripControls(): React.JSX.Element {
  return (
    <div role="toolbar" aria-label="Call controls" className="flex items-center gap-2.5">
      <SelfVoiceToggles className={STRIP_TOGGLE} />
      <ScreenShareControls buttonClassName={STRIP_SHARE} />
      <SoundboardButton className={STRIP_BUTTON} icon={<Ellipsis />} label="More" />
      <Button
        variant="danger"
        className="h-[42px] gap-[7px] px-[18px]"
        onClick={() => voiceService.leaveVoice()}
      >
        <PhoneOff className="size-[15px]" />
        Leave
      </Button>
    </div>
  )
}

/** "3 in the call · 38 ms" under the strip's controls. */
function StripHint(): React.JSX.Element {
  const { count, pingText } = useCallMeta()
  return (
    <p className={cn(CALL_META, 'text-[8.5px] tracking-[1.1px]')}>
      {[`${count} in the call`, pingText].filter(Boolean).join(' · ')}
    </p>
  )
}

/** The phone strip's pills (B5): 42 high, they share the row. */
const MSTRIP_BUTTON =
  "rounded-pill border border-line-strong text-text-secondary h-[42px] flex-1 [&_svg:not([class*='size-'])]:size-[18px]"
const MSTRIP_TOGGLE = cn(
  MSTRIP_BUTTON,
  'aria-pressed:bg-you-tint aria-pressed:border-[1.5px] aria-pressed:border-you aria-pressed:text-you hover:aria-pressed:text-you'
)
const MSTRIP_SHARE = cn(
  MSTRIP_BUTTON,
  'border-transparent bg-here text-on-here hover:text-on-here aria-pressed:bg-live aria-pressed:text-on-live hover:aria-pressed:text-on-live'
)

/** The control row of the call strip above a DM's chat on the phone: mute, deafen, share, more, Leave. */
function MobileStripControls(): React.JSX.Element {
  const platform = usePlatform()
  return (
    <div role="toolbar" aria-label="Call controls" className="flex gap-[9px]">
      <span className="contents" onClickCapture={() => platform.haptic('light')}>
        <SelfVoiceToggles className={MSTRIP_TOGGLE} />
      </span>
      <ScreenShareControls buttonClassName={MSTRIP_SHARE} toggleOnly />
      <SoundboardButton className={MSTRIP_BUTTON} icon={<Ellipsis />} label="More" />
      <button
        type="button"
        onClick={() => voiceService.leaveVoice()}
        className="bg-you text-on-you rounded-pill focus-visible:outline-line-focus active:bg-you/90 flex h-[42px] flex-[1.7] items-center justify-center gap-[7px] text-[13.5px] font-semibold outline-none focus-visible:outline-2"
      >
        <PhoneOff className="size-4" aria-hidden />
        Leave
      </button>
    </div>
  )
}

/** Docked buttons (B4): 56 round, a hairline outline, icon 21. */
const DOCK_BUTTON =
  "size-14 rounded-pill border border-line-strong text-text-secondary active:bg-surface-hover [&_svg:not([class*='size-'])]:size-[21px]"
/** My own muted mic is the one thing on the phone that takes `you`. */
const DOCK_TOGGLE = cn(
  DOCK_BUTTON,
  'aria-pressed:bg-you-tint aria-pressed:border-[1.5px] aria-pressed:border-you aria-pressed:text-you hover:aria-pressed:text-you'
)
/** Share Screen is the phone's primary pill, live while I share. */
const DOCK_SHARE = cn(
  DOCK_BUTTON,
  'border-transparent bg-here text-on-here hover:text-on-here aria-pressed:bg-live aria-pressed:text-on-live hover:aria-pressed:text-on-live'
)

/**
 * The control bar of the stage on the mobile layout (B4), docked at the foot where the voice bar
 * would be: Mute and Deafen (a light haptic), Share Screen where the host can share (not on iOS),
 * the soundboard sheet (decision 6), the way back to the chat of a DM, and Leave as a round
 * vermilion button. No camera.
 */
function DockedControls({ onShowChat }: { onShowChat?: () => void }): React.JSX.Element {
  const platform = usePlatform()
  return (
    <div className="flex shrink-0 flex-col">
      <CallSecurityBanner className="px-3.5 pb-2.5" />
      <div
        role="toolbar"
        aria-label="Call controls"
        className="border-line-hairline flex h-[94px] items-center justify-center gap-3 border-t px-3.5"
      >
        <span className="contents" onClickCapture={() => platform.haptic('light')}>
          <SelfVoiceToggles className={DOCK_TOGGLE} />
        </span>
        <ScreenShareControls buttonClassName={DOCK_SHARE} toggleOnly />
        <SoundboardButton className={DOCK_BUTTON} icon={<Ellipsis />} label="More" />
        {onShowChat && (
          <IconButton label="Show the chat" className={DOCK_BUTTON} onClick={onShowChat}>
            <MessageSquareText />
          </IconButton>
        )}
        <IconButton
          label="Leave"
          className="bg-you text-on-you rounded-pill active:bg-you/90 hover:bg-you/90 hover:text-on-you size-14 [&_svg]:size-[21px]"
          onClick={() => voiceService.leaveVoice()}
        >
          <PhoneOff />
        </IconButton>
      </div>
    </div>
  )
}

/** What a voice channel I am not in shows, on both layouts. */
function useNotJoined(channel: GuildChannel): {
  occupants: VoiceState[]
  /** The first person who streams. */
  streamer: VoiceState | null
  channelName: string
  canConnect: boolean
  canJoin: boolean
  /** The channel of my call elsewhere, which a join moves. */
  otherCallName: string | null
} {
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const canConnect = has(usePermissions(channel.guildId, channel.id), Permissions.CONNECT)
  const canJoin = useCanJoinVoice(channel.guildId, channel.id)
  const otherCallId = useVoiceStore((s) => s.channelId)
  const otherCallName = useChannelStore((s) =>
    otherCallId ? (s.channels.get(otherCallId)?.name ?? null) : null
  )
  return {
    occupants,
    streamer: occupants.find((vs) => vs.selfStream) ?? null,
    channelName: channelLabel(channel).name,
    canConnect,
    canJoin,
    otherCallName
  }
}

/**
 * The title over "Join voice": "<name> is live in <channel>", "n in <channel>", or that no one is
 * there yet.
 */
function NotJoinedTitle({
  channel,
  occupants,
  streamer,
  channelName
}: {
  channel: GuildChannel
  occupants: VoiceState[]
  streamer: VoiceState | null
  channelName: string
}): React.ReactNode {
  if (streamer)
    return (
      <StreamerName guildId={channel.guildId} userId={streamer.userId} channelName={channelName} />
    )
  return occupants.length > 0
    ? `${occupants.length} in ${channelName}`
    : `No one is in ${channelName} yet`
}

/**
 * A voice channel the user is not in (D2). A live stream shows as the live card (decision 4: no
 * frame for non-members), else the people in the channel. Then "Join voice", and a note when the
 * join moves the user's call from another channel.
 */
function NotJoined({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const { occupants, streamer, channelName, canConnect, canJoin, otherCallName } =
    useNotJoined(channel)
  const joinDisabled = !canJoin

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-6">
      {streamer ? (
        <LiveCard
          guildId={channel.guildId}
          userId={streamer.userId}
          channelName={channelName}
          watching={occupants.length - 1}
          size="lg"
        />
      ) : occupants.length > 0 ? (
        <ul
          className={cn(
            'grid w-full max-w-2xl gap-3',
            occupants.length === 1 ? 'max-w-xs grid-cols-1' : 'grid-cols-2 sm:grid-cols-3'
          )}
        >
          {occupants.map((vs) => (
            <ParticipantTile
              key={vs.userId}
              guildId={channel.guildId}
              userId={vs.userId}
              state={vs}
              status={null}
              self={false}
              compact
            />
          ))}
        </ul>
      ) : null}
      <h2 className="text-text-primary text-center text-[22px] leading-7 font-semibold tracking-[-0.3px]">
        <NotJoinedTitle
          channel={channel}
          occupants={occupants}
          streamer={streamer}
          channelName={channelName}
        />
      </h2>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="voice"
          size="lg"
          disabled={joinDisabled}
          onClick={() => void voiceService.join(channel)}
        >
          <PhoneCall />
          Join voice
        </Button>
        {/* N18: a join with the mic muted from the start. The stream needs the call's keys. */}
        {streamer && (
          <Button
            variant="secondary"
            size="lg"
            disabled={joinDisabled}
            onClick={() => void voiceService.join(channel, { muted: true })}
          >
            <Eye />
            Watch stream
          </Button>
        )}
      </div>
      {otherCallName !== null && canConnect && (
        <p className="text-meta text-text-tertiary flex items-center gap-1.5">
          <Info className="size-3.5 shrink-0" aria-hidden />
          You&apos;re in {otherCallName}. Joining moves your call here.
        </p>
      )}
      {!canConnect && (
        <p className="text-meta text-text-tertiary">
          You don&apos;t have permission to join {channelName}.
        </p>
      )}
      <CallSecurityBanner className="w-full max-w-md" />
    </div>
  )
}

/**
 * The mobile form of a voice channel I am not in (M64). What is on scrolls: the full-width live
 * card, who else is in the call, and a 56 row per person. The join block stays at the foot, so
 * "Join voice" is in reach on the smallest phone too: the title, "n in call · region", Join voice,
 * Watch stream (joins muted, N18) and the note that the join moves my call. My call elsewhere
 * keeps its voice bar under it.
 */
function NotJoinedMobile({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const { occupants, streamer, channelName, canConnect, canJoin, otherCallName } =
    useNotJoined(channel)
  const region = useVoiceRegionName(channel.guildId)
  const others = streamer ? occupants.filter((vs) => vs.userId !== streamer.userId) : []
  const sub = streamer
    ? [`${occupants.length} in call`, region].filter(Boolean).join(' · ')
    : region
  const labelId = useId()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-4 pb-6 [&>*]:shrink-0">
        {streamer && (
          <LiveCard
            guildId={channel.guildId}
            userId={streamer.userId}
            channelName={channelName}
            watching={others.length}
            size="stage"
          />
        )}
        {others.length > 0 && <OthersInCall guildId={channel.guildId} occupants={others} />}
        {occupants.length > 0 && (
          <section aria-labelledby={labelId} className="flex flex-col gap-2 pt-1.5">
            <SectionLabel id={labelId}>
              In {channelName} · {occupants.length}
            </SectionLabel>
            <ListGroup>
              <ul className={'divide-line-hairline flex flex-col divide-y'}>
                {occupants.map((vs) => (
                  <VoiceOccupantRow
                    key={vs.userId}
                    guildId={channel.guildId}
                    state={vs}
                    size={56}
                  />
                ))}
              </ul>
            </ListGroup>
          </section>
        )}
        <CallSecurityBanner />
      </div>
      {/* The fade over the scroller's foot shows that more is above; it is invisible on an empty one.
          A mask, not a colour gradient: WebKit draws a gradient from a /0 colour through black. */}
      <div className="before:bg-surface-content relative flex shrink-0 flex-col gap-2.5 px-4 pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:[mask-image:linear-gradient(to_bottom,transparent,black)]">
        <div className="flex flex-col gap-[3px] pb-1.5 text-center">
          <h2 className="text-text-primary text-[20px] leading-6 font-semibold text-balance">
            <NotJoinedTitle
              channel={channel}
              occupants={occupants}
              streamer={streamer}
              channelName={channelName}
            />
          </h2>
          {sub && <p className="text-text-disabled font-mono text-[9px] tracking-[0.9px] uppercase">{sub}</p>}
        </div>
        <Button
          variant="voice"
          size="mobile"
          disabled={!canJoin}
          onClick={() => void voiceService.join(channel)}
        >
          <PhoneCall />
          Join voice
        </Button>
        {streamer && (
          <Button
            variant="secondary"
            size="mobile"
            disabled={!canJoin}
            onClick={() => void voiceService.join(channel, { muted: true })}
          >
            <Eye />
            Watch stream
          </Button>
        )}
        {otherCallName !== null && canConnect && (
          <p className="text-text-tertiary flex items-start justify-center gap-1.5 pt-0.5 text-center text-[13px] leading-4">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            You&apos;re in {otherCallName}. Joining moves your call here.
          </p>
        )}
        {!canConnect && (
          <p className="text-text-tertiary pt-0.5 text-center text-[13px] leading-4">
            You don&apos;t have permission to join {channelName}.
          </p>
        )}
      </div>
    </div>
  )
}

/** At most this many faces before the line under the live card. */
const FACES = 3

/**
 * The line under the live card (M64): up to three faces and the names of the others in the call,
 * "yuki.h, renata and tobias are in the call".
 */
function OthersInCall({
  guildId,
  occupants
}: {
  guildId: string
  occupants: VoiceState[]
}): React.JSX.Element {
  const members = useGuildStore((s) => s.members.get(guildId))
  const text = othersInCallText(occupants.map((vs) => displayName(members?.get(vs.userId))))
  return (
    <p className="text-text-secondary flex min-w-0 items-center gap-2.5 text-[13px] leading-4">
      <AvatarRow size={24} overlap={6}>
        {occupants.slice(0, FACES).map((vs) => (
          <Face key={vs.userId} guildId={guildId} userId={vs.userId} />
        ))}
      </AvatarRow>
      <span className="min-w-0">{text}</span>
    </p>
  )
}

function Face({ guildId, userId }: { guildId: string; userId: string }): React.JSX.Element {
  const { name, avatar } = useMemberView(guildId, userId)
  return <UserAvatar name={name} avatar={avatar} size={24} />
}
