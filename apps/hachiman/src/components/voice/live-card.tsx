import { useEffect, useRef } from 'react'
import { Eye } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { LivePill } from '@/components/ui/live'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'

/** "<name> is live", or "<name> is live in <channel>", with the member's display name. */
export function StreamerName({
  guildId,
  userId,
  channelName
}: {
  guildId: string | null
  userId: string
  channelName?: string
}): React.JSX.Element {
  const { name } = useMemberView(guildId, userId)
  return (
    <>
      {name} is live{channelName !== undefined && ` in ${channelName}`}
    </>
  )
}

const FRAME = {
  sm: {
    box: 'h-12 w-20 shrink-0',
    avatar: 32,
    tag: 'absolute top-0.5 left-0.5'
  },
  md: { box: 'aspect-video w-full', avatar: 48, tag: 'absolute top-1.5 left-1.5' },
  lg: { box: 'aspect-video w-full max-w-2xl', avatar: 112, tag: 'absolute top-3 left-3' },
  // Full width; it keeps its height in a scroller, and the avatar sits above the streamer line.
  stage: {
    // On a short screen (the SE) the card gets lower, so the first occupant row stays in view
    // above the docked join block.
    box: 'aspect-video max-h-[max(120px,calc(var(--app-height,100dvh)-520px))] w-full shrink-0 pb-10',
    avatar: 80,
    tag: 'absolute top-3 left-3'
  },
  strip: {
    box: 'h-[52px] w-full',
    avatar: 32,
    tag: 'absolute top-1.5 left-1.5'
  }
} as const

/**
 * A live stream seen from outside its call (arc plan decision 4). Only members of the call hold
 * the SFrame keys (§12.10), so the card shows the streamer's avatar on the live tint. `stream`
 * (size 'sm' only) is a share that the viewer already watches in that call.
 * - 'sm': a row for the member list; a button when `onClick` is given.
 * - 'md': a tile with the name under it (Active now).
 * - 'lg': the stage of a voice channel the viewer is not in.
 * - 'stage': the same on the mobile layout (M64): full width, with an 80 avatar above a bottom
 *   scrim that carries the streamer, and no "n watching": who watches is not known yet (spec
 *   section 5), the line under the card names who is in the call.
 * - 'strip': the body of a card in the mobile Active now strip (M56), a 52 high frame over the
 *   name. Phrasing content only, as the card is a button.
 */
export function LiveCard({
  guildId,
  userId,
  channelName,
  watching,
  size,
  stream,
  onClick
}: {
  guildId: string | null
  userId: string
  channelName: string
  /** The other people in the channel. */
  watching: number
  size: keyof typeof FRAME
  stream?: MediaStream
  onClick?: () => void
}): React.JSX.Element {
  const { member, name } = useMemberView(guildId, userId)
  const avatar = member?.user.avatar
  const frame = FRAME[size]
  const detail = `${channelName} · ${watching} watching`

  const box = (
    <span
      className={cn(
        'bg-live-tint relative flex items-center justify-center overflow-hidden',
        size !== 'sm' && size !== 'strip' && 'border-live-line border',
        frame.box
      )}
    >
      {stream ? (
        <StreamThumb stream={stream} />
      ) : (
        <UserAvatar
          name={name}
          avatar={avatar}
          size={frame.avatar}
          className={cn(
            size !== 'sm' && 'ring-live-line rounded-full ring-4',
            size === 'strip' && 'ring-2'
          )}
        />
      )}
      {size === 'lg' ? (
        <span className={cn(frame.tag, 'flex items-center gap-1.5')}>
          <LivePill />
          <span className="bg-surface-window/85 rounded-badge text-text-primary flex h-[18px] items-center gap-1 px-1.5 font-mono text-[9px] leading-none tracking-[0.8px] uppercase">
            <Eye className="size-3" aria-hidden />
            {watching} watching
          </span>
        </span>
      ) : (
        <LivePill className={frame.tag} />
      )}
      {size === 'lg' && (
        <span className="absolute bottom-3 left-3 flex min-w-0 items-center gap-2">
          <UserAvatar name={name} avatar={avatar} size={32} />
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate text-sm font-semibold">
              {name}
            </span>
            <span className="text-text-secondary truncate text-xs">Streaming {channelName}</span>
          </span>
        </span>
      )}
      {size === 'stage' && (
        <StageStreamer name={name} avatar={avatar} channelName={channelName} />
      )}
    </span>
  )
  if (size === 'lg' || size === 'stage') return box

  const caption = (
    <span className="flex min-w-0 flex-col text-left">
      <span className="text-text-primary truncate text-[13px] font-semibold">
        <StreamerName guildId={guildId} userId={userId} />
      </span>
      <span className="text-live-text truncate font-mono text-[8.5px] tracking-[0.9px] uppercase">
        {detail}
      </span>
    </span>
  )

  if (size === 'strip')
    return (
      <span className="flex w-full min-w-0 flex-col gap-2">
        {box}
        <span className="flex min-w-0 items-center gap-2 px-1">
          <UserAvatar avatar={avatar} name={name} size={24} />
          <span className="flex min-w-0 flex-col gap-px text-left">
            <span className="text-text-primary truncate text-[13.5px] leading-4 font-semibold">
              <StreamerName guildId={guildId} userId={userId} />
            </span>
            {/* Who watches is not known (spec section 5): the strip counts the call. */}
            <span className="text-text-tertiary truncate text-xs leading-[14px]">
              {channelName} · {watching + 1} in call
            </span>
          </span>
        </span>
      </span>
    )

  if (size === 'md')
    return (
      <div className="flex flex-col gap-2">
        {box}
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar avatar={avatar} name={name} size={24} />
          {caption}
        </div>
      </div>
    )

  const row =
    'rounded-control border-live-line border-l-live bg-surface-raised flex items-center gap-[11px] border border-l-2 px-[13px] py-[11px]'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        row,
        'hover:bg-surface-hover focus-visible:outline-line-focus focus-visible:outline-2'
      )}
    >
      {box}
      {caption}
    </button>
  ) : (
    <div className={row}>
      {box}
      {caption}
    </div>
  )
}

/** The scrim at the foot of the 'stage' card and the streamer over it, in plain text colour. */
function StageStreamer({
  name,
  avatar,
  channelName
}: {
  name: string
  avatar: string | null | undefined
  channelName: string
}): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden
        className="bg-surface-window/90 absolute inset-x-0 bottom-0 h-[100px] [mask-image:linear-gradient(to_bottom,transparent,black)]"
      />
      <span className="absolute right-3 bottom-3 left-3 flex min-w-0 items-center gap-2.5">
        <UserAvatar
          name={name}
          avatar={avatar}
          size={32}
          className="ring-live rounded-full ring-2"
        />
        <span className="flex min-w-0 flex-col gap-px text-left">
          <span className="text-text-primary truncate text-[15px] leading-[18px] font-semibold">
            {name}
          </span>
          <span className="text-text-secondary truncate text-xs leading-[14px]">
            Streaming {channelName}
          </span>
        </span>
      </span>
    </>
  )
}

function StreamThumb({ stream }: { stream: MediaStream }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current) video.current.srcObject = stream
  }, [stream])
  return <video ref={video} autoPlay muted playsInline className="size-full object-cover" />
}
