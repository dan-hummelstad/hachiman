import { Check, Hand, X } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { useLayout } from '@/hooks/use-layout'
import { POKE_SENT_MS, pokeService, usePoke } from '@/services/poke'
import { usePokeStore, type PokeToast } from '@/stores/pokeStore'

/**
 * The poke toasts in the bottom right corner, newest at the bottom. On the mobile layout they sit
 * at full width under the tab strip, clear of the composer and the home indicator.
 */
export function PokeToasts(): React.JSX.Element | null {
  const toasts = usePokeStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="mobile:inset-x-4 mobile:top-[calc(var(--safe-top,0px)+56px)] mobile:bottom-auto mobile:w-auto pointer-events-none fixed right-4 bottom-4 z-50 flex w-72 flex-col gap-2"
    >
      {toasts.map((t) => (
        <PokeToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}

function PokeToastCard({ toast }: { toast: PokeToast }): React.JSX.Element {
  const back = usePoke()
  const touch = useLayout() === 'mobile'
  const { user } = toast
  return (
    <div className="bg-popover text-popover-foreground pointer-events-auto flex flex-col gap-2 rounded-lg border p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <UserAvatar name={user.username} avatar={user.avatar} size={28} />
        <p className="text-text-primary min-w-0 flex-1 truncate text-sm font-semibold">
          {user.username} poked you
        </p>
        <IconButton
          label="Dismiss"
          size={touch ? 'touch' : 'sm'}
          onClick={() => pokeService.dismiss(toast.id)}
        >
          <X />
        </IconButton>
      </div>
      <Button
        size="sm"
        className="mobile:h-9"
        disabled={back.busy || back.sent}
        onClick={() =>
          void back.run(user.id, user.username).then((ok) => {
            if (ok) setTimeout(() => pokeService.dismiss(toast.id), POKE_SENT_MS)
          })
        }
      >
        {back.sent ? <Check /> : <Hand />}
        {back.sent ? 'Poke sent!' : 'Poke back'}
      </Button>
      <ErrorText>{back.error}</ErrorText>
    </div>
  )
}
