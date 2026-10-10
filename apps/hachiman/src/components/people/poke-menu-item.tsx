import { Check, Hand } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { usePoke } from '@/services/poke'

/**
 * "Poke" in a user's More menu. The menu stays open after the select, so the item can show
 * "Poke sent!". The caller owns `poke`, so it shows `poke.error` where it fits.
 */
export function PokeMenuItem({
  poke,
  userId,
  name
}: {
  poke: ReturnType<typeof usePoke>
  userId: string
  name: string
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      disabled={poke.busy || poke.sent}
      onSelect={(e) => {
        e.preventDefault()
        void poke.run(userId, name)
      }}
    >
      {poke.sent ? <Check /> : <Hand />}
      {poke.sent ? 'Poke sent!' : 'Poke'}
    </DropdownMenuItem>
  )
}
