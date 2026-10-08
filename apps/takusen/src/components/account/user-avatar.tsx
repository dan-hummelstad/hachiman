import { initialsFor } from '@/components/initials'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/** The user's avatar: a circle (avatars are rounded), initials when there is no image. */
export function UserAvatar({
  name,
  email,
  src,
  size,
  className,
}: {
  name: string
  email: string
  src: string | null
  size: number
  className?: string
}): React.JSX.Element {
  return (
    <Avatar className={cn('rounded-full', className)} style={{ width: size, height: size }}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback className="rounded-full font-extrabold" style={{ fontSize: Math.round(size * 0.36) }}>
        {initialsFor(name, email)}
      </AvatarFallback>
    </Avatar>
  )
}
