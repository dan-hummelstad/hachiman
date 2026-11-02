import { useState } from 'react'
import {
  Headphones,
  HeadphoneOff,
  LogOut,
  MessageSquareText,
  Mic,
  MicOff,
  Settings
} from 'lucide-react'
import { closeDrawer } from '@/components/mobile/drawer-state'
import { CustomStatusDialog } from '@/components/people/custom-status-dialog'
import { UserAvatar } from '@/components/shell/user-avatar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { OWN_STATUS_LABEL, PresenceDot, STATUSES } from '@/components/ui/presence'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { cn } from '@/lib/utils'
import { setMyStatus } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { voiceService } from '@/services/VoiceService'
import { openSettings, useNavStore } from '@/stores/navStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * My avatar at the right of the mobile sidebar controls row: a tap closes the drawer and pushes
 * the settings list, whose status chip and sign-out row take the place of the desktop menu. The
 * desktop has the `UserBar` at the foot of the sidebar.
 */
export function MeButton(): React.JSX.Element {
  return <MobileMeButton />
}

/** My avatar with my status, the face of both buttons. */
function MeAvatar(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const handle = useTakusenStore((s) => s.session?.user.handle)
  return (
    <UserAvatar
      name={me?.username ?? handle ?? 'Guest'}
      avatar={me?.avatar}
      size={24}
      status={status}
      cutout="bg-surface-window"
      ringHole
    />
  )
}

function MobileMeButton(): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label="User settings"
      onClick={() => {
        closeDrawer()
        openSettings({ kind: 'user' })
      }}
      className="active:bg-surface-hover flex size-9 shrink-0 items-center justify-center rounded-full"
    >
      <MeAvatar />
    </button>
  )
}

/**
 * The desktop user bar at the foot of the sidebar: my avatar and status, then mic, headphones and
 * settings. The avatar and name open the status menu on right click, and user settings on click.
 */
export function UserBar(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const handle = useTakusenStore((s) => s.session?.user.handle)
  const selfMute = useVoiceStore((s) => s.selfMute)
  const selfDeaf = useVoiceStore((s) => s.selfDeaf)
  const settingsOpen = useNavStore((s) => s.settings?.target.kind === 'user')
  const custom = useCustomStatus(me?.id ?? '')
  const [statusOpen, setStatusOpen] = useState(false)
  const name = me?.username ?? handle ?? 'Guest'

  return (
    <>
      <div
        data-slot="user-bar"
        className="border-line-hairline flex h-14 shrink-0 items-center gap-[9px] border-t px-3"
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              aria-label="User settings"
              aria-current={settingsOpen ? 'page' : undefined}
              onClick={() => openSettings({ kind: 'user' })}
              className="rounded-row flex min-w-0 flex-1 items-center gap-[9px] text-left outline-none focus-visible:outline-2 focus-visible:outline-line-focus"
            >
              <UserAvatar
                name={name}
                avatar={me?.avatar}
                size={28}
                status={status}
                cutout="bg-surface-panel"
              />
              <span className="grid min-w-0">
                <span className="text-text-primary truncate text-[13px] leading-4 font-semibold">
                  {name}
                </span>
                <span className="cap-sm truncate">
                  {custom ? custom.text : `@${handle ?? name} · ${OWN_STATUS_LABEL[status]}`}
                </span>
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuLabel className="cap">Status</ContextMenuLabel>
            {STATUSES.map((s) => (
              <ContextMenuItem key={s} onSelect={() => setMyStatus(s)}>
                <span className="flex size-4 items-center justify-center">
                  <PresenceDot status={s} />
                </span>
                <span className={cn(status === s && 'font-semibold')}>{OWN_STATUS_LABEL[s]}</span>
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!me} onSelect={() => setStatusOpen(true)}>
              <MessageSquareText />
              <span className="flex min-w-0 flex-col">
                <span>{custom ? 'Edit status' : 'Set a status'}</span>
                {custom && (
                  <span className="text-text-tertiary truncate text-xs">{custom.text}</span>
                )}
              </span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => takusenService.signOut()}>
              <LogOut /> Sign out
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <div className="flex shrink-0 items-center gap-[11px]">
          <BarButton
            label={selfMute ? 'Unmute' : 'Mute'}
            onClick={() => voiceService.toggleMute()}
            className={selfMute ? 'text-you-text' : undefined}
          >
            {selfMute ? <MicOff /> : <Mic />}
          </BarButton>
          <BarButton
            label={selfDeaf ? 'Undeafen' : 'Deafen'}
            onClick={() => voiceService.toggleDeaf()}
            className={selfDeaf ? 'text-you-text' : undefined}
          >
            {selfDeaf ? <HeadphoneOff /> : <Headphones />}
          </BarButton>
          <BarButton label="User settings" onClick={() => openSettings({ kind: 'user' })}>
            <Settings />
          </BarButton>
        </div>
      </div>
      {me && (
        <CustomStatusDialog userId={me.id} open={statusOpen} onClose={() => setStatusOpen(false)} />
      )}
    </>
  )
}

function BarButton({
  label,
  onClick,
  className,
  children
}: {
  label: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            'text-text-tertiary hover:text-text-primary rounded-row flex shrink-0 items-center justify-center outline-none focus-visible:outline-2 focus-visible:outline-line-focus [&_svg]:size-[15px]',
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
