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
import {
  closeStatusSheet,
  isStatus,
  openCustomStatusSheet,
  STATUSES,
  useStatusSheetStore,
  type StatusSheetOpen
} from '@/components/settings/status-sheet-state'
import { OWN_STATUS_LABEL, PresenceDot } from '@/components/ui/presence'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { useLatched } from '@/hooks/use-latched'
import { setMyStatus } from '@/services/hachiman'
import { useUserStore } from '@/stores/userStore'

/**
 * The status sheet and the "Set a status" sheet, mounted by `<Dialogs/>` from the first open on.
 * Between opens they stay mounted, so they can slide out.
 */
export function StatusSheets(): React.JSX.Element | null {
  const open = useStatusSheetStore((s) => s.open)
  const shown = useLatched(open)
  return shown === null ? null : <StatusSheetPair open={open} />
}

/**
 * My status from the mobile settings list (M29): the four presence choices as radio rows, then
 * "Set a status", which opens the custom status sheet in place of this one.
 */
function StatusSheetPair({ open }: { open: StatusSheetOpen | null }): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const custom = useCustomStatus(me?.id ?? '')
  return (
    <>
      <MenuSheet open={open === 'status'} onOpenChange={(o) => !o && closeStatusSheet('status')}>
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
          <MenuSheetItem disabled={!me} onSelect={openCustomStatusSheet}>
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
      {me && (
        <CustomStatusDialog
          userId={me.id}
          open={open === 'custom'}
          onClose={() => closeStatusSheet('custom')}
        />
      )}
    </>
  )
}
