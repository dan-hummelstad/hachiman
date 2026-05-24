import { ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { OracleSignInDialog } from '@/components/oracle-signin-dialog'
import { useOracleStore } from '@/stores/oracleStore'

/**
 * Passive banner shown to anonymous users in the sidebar / server-rail header.
 * Disappears once an Oracle session is established. Dismiss is per-session
 * (local state) so closing it doesn't hide the prompt forever.
 */
export function OracleSignInPrompt(): React.JSX.Element | null {
  const session = useOracleStore((s) => s.session)
  const [dismissed, setDismissed] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  if (session) return null
  if (dismissed) return null

  return (
    <>
      <div className="bg-sidebar-accent/40 m-2 flex flex-col gap-2 rounded-md border p-3 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-blue-500" aria-hidden />
            Sign in to Takusen
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="text-muted-foreground">
          Sync your servers across devices and get a verified badge in channels.
        </p>
        <Button size="sm" onClick={() => setDialogOpen(true)} className="self-start">
          Sign in
        </Button>
      </div>
      <OracleSignInDialog isOpen={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  )
}
