'use client'

import { ArrowLeftRightIcon, ChevronDownIcon, LogOutIcon, UserRoundIcon } from 'lucide-react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'

import { EntityAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** The signed-in Takusen account on an SSO page (consent, invite). */
export interface SsoAccount {
  name: string
  email: string
  avatarUrl: string | null
}

/** Top bar account chip of a signed-in SSO page: avatar and name; the menu opens the account or signs out. */
export function AccountChip({ account }: { account: SsoAccount }): React.JSX.Element {
  const label = account.name || account.email
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account: ${label}`}
          className="flex h-[38px] items-center gap-2 rounded-pill border border-line-hairline bg-surface-hover pr-3 pl-[5px] text-sm font-extrabold text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:size-[38px] max-sm:border-0 max-sm:bg-transparent max-sm:p-0"
        >
          <EntityAvatar
            src={account.avatarUrl}
            name={account.name}
            email={account.email}
            size={28}
            tone="hachiman"
            className="max-sm:size-8!"
          />
          <span className="max-w-40 truncate max-sm:hidden">{label}</span>
          <ChevronDownIcon aria-hidden className="size-[15px] text-text-tertiary max-sm:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="flex min-w-0 flex-col px-2 py-1.5">
          <span className="truncate text-sm leading-5 font-bold">{account.name || 'User'}</span>
          <span className="truncate text-xs leading-4 text-text-tertiary">{account.email}</span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRoundIcon />
            <span>Your account</span>
          </Link>
        </DropdownMenuItem>
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

/** Signs out, then back through sign-in to `next`, so another account can answer. */
export function SwitchAccountButton({ next }: { next: string }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      onClick={() => void signOut({ callbackUrl: `/login?next=${encodeURIComponent(next)}` })}
    >
      <ArrowLeftRightIcon aria-hidden />
      Switch
    </Button>
  )
}
