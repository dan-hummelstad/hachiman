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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface UserMenuProps {
  name: string
  email: string
}

function initialsFor(name: string, email: string): string {
  const source = name.trim() || email
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

export function UserMenu({ name, email }: UserMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open user menu"
          className="rounded-full"
        >
          <Avatar size="sm">
            <AvatarFallback>{initialsFor(name, email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="truncate text-sm font-medium text-foreground">
              {name || 'User'}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {email}
            </span>
          </div>
        </DropdownMenuLabel>
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
            void signOut({ callbackUrl: '/' })
          }}
        >
          <LogOutIcon />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
