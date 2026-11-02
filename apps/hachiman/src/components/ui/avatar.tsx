import * as React from 'react'
import * as AvatarPrimitive from '@radix-ui/react-avatar'

import { hashString } from '@/lib/hash'
import { cn } from '@/lib/utils'

const SHADES = ['bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3'] as const

/** The fallback fill for `id` (a name, an id): one of three neutral shades, stable per id. */
export const avatarShade = (id: string): string => SHADES[hashString(id) % 3]

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-[22%] mobile:rounded-full', className)}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn('aspect-square size-full object-cover', className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        typeof children === 'string' ? avatarShade(children) : 'bg-avatar-1',
        'text-text-secondary flex size-full items-center justify-center rounded-[22%] font-mono text-xs font-medium select-none mobile:rounded-full',
        className
      )}
      {...props}
    >
      {children}
    </AvatarPrimitive.Fallback>
  )
}

export { Avatar, AvatarImage, AvatarFallback }
