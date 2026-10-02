import { LogOut, Settings } from 'lucide-react'
import type { PresenceStatus } from '@hachiman/client'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { PRESENCE_LABEL, PresenceDot } from '@/components/ui/presence'
import { UserAvatar } from '@/components/shell/user-avatar'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { setMyStatus } from '@/services/hachiman'
import { oracleService } from '@/services/OracleService'
import { openDialog } from '@/stores/dialogStore'
import { useOracleStore } from '@/stores/oracleStore'
import { useUserStore } from '@/stores/userStore'

/** For my own status, offline is a choice: "Invisible". */
const STATUS_LABEL: Record<PresenceStatus, string> = { ...PRESENCE_LABEL, offline: 'Invisible' }
const STATUSES: PresenceStatus[] = ['online', 'idle', 'dnd', 'offline']

/**
 * User panel at the bottom of the channel sidebar (52px): avatar + presence,
 * name + status, and mic / deafen / settings buttons. The avatar and name open
 * the status menu.
 */
export function NavUser(): React.JSX.Element {
  const isMobile = useIsMobile()
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const oracleHandle = useOracleStore((s) => s.session?.user.handle)

  const name = me?.username ?? oracleHandle ?? 'Guest'

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-1 border-t px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Set status"
            className="hover:bg-accent data-[state=open]:bg-accent flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left"
          >
            <UserAvatar name={name} avatar={me?.avatar} size={32} status={status} />
            <span className="grid min-w-0 leading-tight">
              <span className="truncate text-[13px] font-semibold">{name}</span>
              <span className="text-muted-foreground truncate text-xs">{STATUS_LABEL[status]}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-56"
          side={isMobile ? 'bottom' : 'top'}
          align="start"
          sideOffset={6}
        >
          <DropdownMenuLabel className="text-muted-foreground text-xs font-semibold">
            Status
          </DropdownMenuLabel>
          {STATUSES.map((s) => (
            <DropdownMenuItem key={s} onSelect={() => setMyStatus(s)}>
              <span className="flex size-4 items-center justify-center">
                <PresenceDot status={s} />
              </span>
              <span className={cn(status === s && 'font-semibold')}>{STATUS_LABEL[s]}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => oracleService.signOut()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SelfVoiceToggles />
      <IconButton label="User settings" onClick={() => openDialog({ kind: 'userSettings' })}>
        <Settings />
      </IconButton>
    </div>
  )
}
