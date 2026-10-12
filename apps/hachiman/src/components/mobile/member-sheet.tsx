import { useState } from 'react'
import { Check, Copy, MessageCircle } from 'lucide-react'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetItem,
  MenuSheetSeparator
} from '@/components/mobile/menu-sheet'
import {
  ModerationDialogs,
  ModerationMenuItems,
  type ModerationDialog
} from '@/components/people/member-moderation'
import { PokeMenuItem } from '@/components/people/poke-menu-item'
import { useModerationRights } from '@/components/people/use-moderation-rights'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { useCopy } from '@/hooks/use-copy'
import { useMemberView, useOpenDm, usePresence } from '@/hooks/use-member'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { usePoke } from '@/services/poke'
import { useIsBlocked, useUserStore } from '@/stores/userStore'

/**
 * The hold menu of a member row in the members drawer (docs/ios-mobile-ui-spec.md A4): who it is,
 * then Message, Poke and Copy username, then the moderation items that I may use. Message and a
 * moderation change keep the sheet open while they run, so an error shows in it, and close it when
 * they went through. Poke and Copy show their result in the row. Kick and ban close the sheet and
 * ask in their confirm window. Mobile layout only: its rows are `MenuSheet` rows.
 */
export function MemberSheet({
  guildId,
  userId,
  open,
  onOpenChange
}: {
  guildId: string
  userId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { member, name, ink } = useMemberView(guildId, userId)
  const status = usePresence(userId)
  const isMe = useUserStore((s) => s.me?.id === userId)
  const blocked = useIsBlocked(userId)
  const dm = useOpenDm(userId)
  const poke = usePoke()
  const moderate = useAction()
  const rights = useModerationRights(guildId, userId)
  const copy = useCopy()
  const [dialog, setDialog] = useState<ModerationDialog | null>(null)
  const username = member?.user.username
  const close = (): void => onOpenChange(false)
  const errors = [
    copy.failed ? 'Could not copy the username.' : null,
    dm.error,
    poke.error,
    moderate.error
  ].filter((error) => error !== null)

  return (
    <>
      <MenuSheet open={open} onOpenChange={onOpenChange}>
        <MenuSheetContent title={name}>
          <div className={cn('flex min-w-0 items-center gap-3 px-1 pb-3', ROLE_INK_SCOPE)}>
            <UserAvatar
              avatar={member?.user.avatar}
              name={name}
              color={ink}
              size={40}
              status={status}
              cutout="bg-surface-panel"
            />
            <span className="flex min-w-0 flex-col">
              <span
                className="text-text-primary truncate text-[16px] leading-5 font-extrabold"
                style={ink ? { color: ink } : undefined}
              >
                {name}
              </span>
              {username && (
                <span className="text-text-tertiary truncate font-mono text-[13px] leading-4">
                  {username}
                </span>
              )}
            </span>
          </div>
          {!isMe && (
            <MenuSheetItem
              disabled={dm.busy || blocked}
              onSelect={(e) => {
                e.preventDefault()
                void dm.open().then((ok) => ok && close())
              }}
            >
              <MessageCircle /> Message
            </MenuSheetItem>
          )}
          {!isMe && !blocked && <PokeMenuItem poke={poke} userId={userId} name={name} />}
          {username && (
            <MenuSheetItem
              onSelect={(e) => {
                e.preventDefault()
                copy.copy(username)
              }}
            >
              {copy.copied !== null ? <Check /> : <Copy />}
              {copy.copied !== null ? 'Copied' : 'Copy username'}
            </MenuSheetItem>
          )}
          <ModerationMenuItems
            guildId={guildId}
            userId={userId}
            name={name}
            rights={rights}
            action={moderate}
            onDialog={setDialog}
            onDone={close}
          />
          {errors.length > 0 && (
            <>
              <MenuSheetSeparator />
              <div className="flex flex-col gap-1 px-1">
                {errors.map((error) => (
                  <ErrorText key={error}>{error}</ErrorText>
                ))}
              </div>
            </>
          )}
        </MenuSheetContent>
      </MenuSheet>
      <ModerationDialogs
        guildId={guildId}
        userId={userId}
        name={name}
        open={dialog}
        onClose={() => setDialog(null)}
      />
    </>
  )
}
