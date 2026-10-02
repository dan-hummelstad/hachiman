import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { GuildTile } from '@/components/ui/guild-tile'
import { ModalWindow } from '@/components/ui/modal-window'
import { Skeleton } from '@/components/ui/skeleton'
import { useAction } from '@/hooks/use-action'
import { useKeyedAsync } from '@/hooks/use-keyed-async'
import { useSignIn } from '@/hooks/use-sign-in'
import { acceptInvite, previewInvite } from '@/services/InviteService'
import { useDialog } from '@/stores/dialogStore'
import { useOracleStore } from '@/stores/oracleStore'

/** Opened by an invite deep link: preview the guild, then accept. */
export function JoinServerModal(): React.JSX.Element {
  const {
    dialog: { code },
    open,
    close
  } = useDialog('joinInvite')
  const session = useOracleStore((s) => s.session)
  const result = useKeyedAsync(code, previewInvite)
  const preview = result?.data ?? null
  const loadError = result?.error ?? null
  const { run, busy, error } = useAction()

  const join = async (): Promise<void> => {
    if ((await run('join', () => acceptInvite(code))).ok) close()
  }

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title="Guild invite"
      description="You’ve been invited to join a guild."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {loadError ? 'Close' : 'Not now'}
          </Button>
          {!loadError && (
            <Button disabled={!session || !preview || busy} onClick={() => void join()}>
              {busy ? 'Joining…' : 'Accept invite'}
            </Button>
          )}
        </>
      }
    >
      <div className="bg-card flex items-center gap-4 border p-4">
        {preview ? (
          <>
            <GuildTile guild={preview.guild} size="lg" />
            <span className="grid min-w-0">
              <span className="truncate text-[15px] leading-5 font-semibold">
                {preview.guild.name}
              </span>
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs tabular-nums">
                <span aria-hidden className="bg-online size-2" />
                {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
              </span>
            </span>
          </>
        ) : loadError ? (
          <span className="grid gap-1">
            <span className="text-sm font-semibold">This invite doesn’t work</span>
            <span className="text-muted-foreground text-xs leading-4">
              It may have expired or been revoked ({loadError}). Ask whoever sent it for a new one.
            </span>
          </span>
        ) : (
          <>
            <Skeleton className="size-14 shrink-0" />
            <span className="grid flex-1 gap-2" aria-label="Loading invite">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </span>
          </>
        )}
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        Invite code <span className="text-foreground font-mono text-[13px]">{code}</span>
      </p>
      {!session && <SignInPrompt code={code} />}
      <ErrorText>{error}</ErrorText>
    </ModalWindow>
  )
}

/** Shown when the invite opens while signed out: sign in first, then accept. */
function SignInPrompt({ code }: { code: string }): React.JSX.Element {
  const { signIn, busy, error } = useSignIn(code)
  return (
    <div className="grid gap-2">
      <div className="bg-card flex items-center gap-3 border p-3">
        <span className="flex-1 text-sm">Sign in with Takusen to accept this invite.</span>
        <Button size="sm" disabled={busy} onClick={() => void signIn()}>
          {busy ? 'Opening…' : 'Sign in'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
