import { useState } from 'react'
import { LogOut, MessageSquareText } from 'lucide-react'
import type { PresenceStatus } from '@hachiman/client'
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
import { OWN_STATUS_LABEL, PresenceDot } from '@/components/ui/presence'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { cn } from '@/lib/utils'
import { setMyStatus } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { openSettings, useNavStore } from '@/stores/navStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

const STATUSES: PresenceStatus[] = ['online', 'idle', 'dnd', 'offline']

/**
 * My avatar (24, with my status) at the right of the sidebar controls row: opens user settings
 * (ringed while they are open). Right click: status, custom status and sign out.
 */
export function MeButton(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const handle = useTakusenStore((s) => s.session?.user.handle)
  const settingsOpen = useNavStore((s) => s.settings?.target.kind === 'user')
  const name = me?.username ?? handle ?? 'Guest'
  const custom = useCustomStatus(me?.id ?? '')
  const [statusOpen, setStatusOpen] = useState(false)

  return (
    <>
      <ContextMenu>
        <Tooltip>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="User settings"
                aria-current={settingsOpen ? 'page' : undefined}
                onClick={() => openSettings({ kind: 'user' })}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full mobile:size-9',
                  settingsOpen && 'ring-text-primary ring-2'
                )}
              >
                <UserAvatar
                  name={name}
                  avatar={me?.avatar}
                  size={24}
                  status={status}
                  cutout="bg-surface-window"
                  ringHole
                />
              </button>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent side="bottom">User settings</TooltipContent>
        </Tooltip>
        <ContextMenuContent className="w-52">
          <ContextMenuLabel className="text-text-tertiary text-xs font-semibold">
            Status
          </ContextMenuLabel>
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
              {custom && <span className="text-text-tertiary truncate text-xs">{custom.text}</span>}
            </span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => takusenService.signOut()}>
            <LogOut /> Sign out
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {me && (
        <CustomStatusDialog userId={me.id} open={statusOpen} onClose={() => setStatusOpen(false)} />
      )}
    </>
  )
}
