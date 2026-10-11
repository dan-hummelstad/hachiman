import { MessageSquareText } from 'lucide-react'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetSeparator
} from '@/components/mobile/menu-sheet'
import { CustomStatusDialog } from '@/components/people/custom-status-dialog'
import { isStatus, OWN_STATUS_LABEL, PresenceDot, STATUSES } from '@/components/ui/presence'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { setMyStatus } from '@/services/hachiman'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { useUserStore } from '@/stores/userStore'

/**
 * My status from the mobile settings list (M29): the four presence choices as radio rows, then
 * "Set a status", which opens the custom status sheet in place of this one.
 */
export function StatusSheet(): React.JSX.Element {
  const { open, close } = useDialog('status')
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const custom = useCustomStatus(me?.id ?? '')
  return (
    <MenuSheet open={open} onOpenChange={(o) => !o && close()}>
      <MenuSheetContent title="Status">
        <MenuSheetLabel>Status</MenuSheetLabel>
        <MenuSheetRadioGroup
          aria-label="Status"
          value={status}
          onValueChange={(v) => isStatus(v) && setMyStatus(v)}
        >
          {STATUSES.map((s) => (
            <MenuSheetRadioItem key={s} value={s}>
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                <PresenceDot status={s} className="size-2.5" />
              </span>
              {OWN_STATUS_LABEL[s]}
            </MenuSheetRadioItem>
          ))}
        </MenuSheetRadioGroup>
        <MenuSheetSeparator />
        <MenuSheetItem disabled={!me} onSelect={() => openDialog({ kind: 'customStatus' })}>
          <MessageSquareText />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{custom ? 'Edit status' : 'Set a status'}</span>
            {custom && (
              <span className="text-text-tertiary truncate text-[13px] leading-4 font-medium">
                {custom.text}
              </span>
            )}
          </span>
        </MenuSheetItem>
      </MenuSheetContent>
    </MenuSheet>
  )
}

/** "Set a status" from the status sheet. */
export function CustomStatusSheet(): React.JSX.Element {
  const { open, close } = useDialog('customStatus')
  const me = useUserStore((s) => s.me)
  return <>{me && <CustomStatusDialog userId={me.id} open={open} onClose={close} />}</>
}
