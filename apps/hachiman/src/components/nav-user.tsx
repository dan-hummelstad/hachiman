import { useState } from 'react'
import {
  BadgeCheck,
  Bell,
  ChevronsUpDown,
  CreditCard,
  LogIn,
  LogOut,
  ShieldCheck
} from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'
import { OracleSignInDialog } from '@/components/oracle-signin-dialog'
import { oracleService } from '@/services/OracleService'
import { useOracleStore } from '@/stores/oracleStore'
import { useUserStore } from '@/stores/userStore'
import { ThemeToggle } from './theme-toggle'

export function NavUser({
  user
}: {
  user: {
    name: string
    email: string
    avatar?: string
  }
}): React.JSX.Element {
  const isMobile = useIsMobile()
  const username = useUserStore((s) => s.username)
  const oracleSession = useOracleStore((s) => s.session)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Prefer Oracle identity when signed in; fall back to UserStore username;
  // finally fall back to whatever the caller passed (legacy placeholder data).
  const displayName = oracleSession?.user.handle ?? username ?? user.name
  const displayEmail = oracleSession?.user.email ?? user.email
  const initials = (displayName || 'U').slice(0, 1).toUpperCase()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground flex w-full items-center gap-2 rounded-md p-2 text-left text-sm transition-colors"
          >
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarImage src={user.avatar} alt={displayName} />
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="flex items-center gap-1 truncate font-medium">
                {displayName}
                {oracleSession && (
                  <BadgeCheck className="h-3 w-3 shrink-0 text-blue-500" aria-label="Verified" />
                )}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {displayEmail || 'Not signed in to Takusen'}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          side={isMobile ? 'bottom' : 'right'}
          align="end"
          sideOffset={4}
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={user.avatar} alt={displayName} />
                <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{displayName}</span>
                <span className="truncate text-xs">{displayEmail}</span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <ThemeToggle />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <BadgeCheck />
              Account
            </DropdownMenuItem>
            <DropdownMenuItem>
              <CreditCard />
              Billing
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Bell />
              Notifications
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {oracleSession ? (
            <DropdownMenuItem onSelect={() => oracleService.signOut()}>
              <LogOut />
              Sign out of Takusen
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
              <ShieldCheck />
              Sign in with Takusen
            </DropdownMenuItem>
          )}
          <DropdownMenuItem>
            <LogIn />
            App settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <OracleSignInDialog isOpen={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  )
}
