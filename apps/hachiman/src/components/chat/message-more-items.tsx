import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { MORE_ACTIONS, findAction, type MessageAction } from './message-actions'

/**
 * The items of a message's "More" menu, from the row's actions (`useMessageActions`). A row that
 * did not decrypt can be pinned but starts no thread (its text is unknown).
 */
export function MessageMoreItems({
  actions
}: {
  actions: readonly MessageAction[]
}): React.JSX.Element {
  return (
    <>
      {MORE_ACTIONS.map((id) => {
        const action = findAction(actions, id)
        if (!action) return null
        return (
          <DropdownMenuItem
            key={id}
            hint={action.hint ?? undefined}
            onSelect={() => void action.run()}
          >
            <action.icon />
            {action.label}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
