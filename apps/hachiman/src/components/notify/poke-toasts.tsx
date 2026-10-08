import { Hand, X } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { useAction } from '@/hooks/use-action'
import { pokeService } from '@/services/poke'
import { usePokeStore, type PokeToast } from '@/stores/pokeStore'

/** The poke toasts in the bottom right corner, newest at the bottom. */
export function PokeToasts(): React.JSX.Element | null {
  const toasts = usePokeStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-72 flex-col gap-2"
    >
      {toasts.map((t) => (
        <PokeToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}

function PokeToastCard({ toast }: { toast: PokeToast }): React.JSX.Element {
  const back = useAction()
  const { user } = toast
  return (
    <div className="bg-popover text-popover-foreground pointer-events-auto flex flex-col gap-2 rounded-lg border p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <UserAvatar name={user.username} avatar={user.avatar} size={28} />
        <p className="text-text-primary min-w-0 flex-1 truncate text-sm font-semibold">
          {user.username} poked you
        </p>
        <IconButton label="Dismiss" size="sm" onClick={() => pokeService.dismiss(toast.id)}>
          <X />
        </IconButton>
      </div>
      <Button
        size="sm"
        disabled={back.busy}
        onClick={() =>
          void back
            .run(`poke ${user.username}`, () => pokeService.poke(user.id))
            .then((r) => r.ok && pokeService.dismiss(toast.id))
        }
      >
        <Hand /> Poke back
      </Button>
      {back.error && <p className="text-feature-danger-text text-xs">{back.error}</p>}
    </div>
  )
}
