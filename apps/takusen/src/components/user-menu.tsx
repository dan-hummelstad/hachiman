'use client'

import { LogOutIcon, UserIcon } from 'lucide-react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { initialsFor } from '@/components/initials'
import { cn } from '@/lib/utils'

export interface UserMenuProps {
  name: string
  email: string
}

export function signOutToHome(): void {
  void signOut({ callbackUrl: '/' })
}

export function UserMenu({ name, email }: UserMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open user menu">
          <Avatar size="sm">
            <AvatarFallback>{initialsFor(name, email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <UserIdentity name={name} email={email} className="px-2 py-1.5" />
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserIcon />
            <span>Account</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.preventDefault()
            signOutToHome()
          }}
        >
          <LogOutIcon />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Name over email, both truncated: the user menu header and the nav's user panel. */
export function UserIdentity({
  name,
  email,
  className,
}: UserMenuProps & { className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <span className="truncate text-sm leading-5 font-semibold">{name || 'User'}</span>
      <span className="truncate text-xs leading-4 text-muted-foreground">{email}</span>
    </div>
  )
}
