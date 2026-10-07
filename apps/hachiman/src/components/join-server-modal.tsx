import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { GuildTile } from '@/components/ui/guild-tile'
import { ModalWindow } from '@/components/ui/modal-window'
import { Skeleton } from '@/components/ui/skeleton'
import { Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { useKeyedAsync } from '@/hooks/use-keyed-async'
import { useSignIn } from '@/hooks/use-sign-in'
import {
  acceptInvite,
  peekInviteKey,
  previewInvite,
  stashInviteKey
} from '@/services/InviteService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'
import { useTakusenStore } from '@/stores/takusenStore'

/**
 * Opened by an invite deep link: preview the guild, then accept. The key of an invite with history
 * (`#k=`) comes from InviteService memory and stays in component state (§12.17). When encryption
 * cannot run in this window (another tab holds the crypto store, for example), the join would use
 * the invite without the history: the user must agree to that first.
 */
export function JoinServerModal(): React.JSX.Element {
  const {
    dialog: { code },
    open,
    close
  } = useDialog('joinInvite')
  const session = useTakusenStore((s) => s.session)
  const result = useKeyedAsync(code, previewInvite)
  const preview = result?.data ?? null
  const loadError = result?.error ?? null
  const [key] = useState(() => peekInviteKey(code))
  const { run, busy, error } = useAction()
  // The redemption waits for the crypto Worker, which never starts in this window (§12.17).
  const cryptoBlocked = useCryptoStore((s) => s.phase === 'error' || s.fatal !== null)
  const lockHeld = useCryptoStore((s) => s.startError?.code === 'LockHeld')
  const historyBlocked = key !== null && preview?.hasHistory === true && cryptoBlocked
  const [withoutHistory, setWithoutHistory] = useState(false)
  const checkId = useId()

  // Closed without a join, also when another dialog takes its place: forget the key (§12.17).
  useEffect(() => {
    if (!open) stashInviteKey(code, null)
  }, [open, code])

  const join = async (): Promise<void> => {
    const historyKey = preview?.hasHistory ? key : null
    if ((await run('join', () => acceptInvite(code, historyKey))).ok) close()
  }

  const dismiss = (): void => {
    stashInviteKey(code, null)
    close()
  }

  return (
    <ModalWindow
      open={open}
      onClose={dismiss}
      title="Guild invite"
      description="You’ve been invited to join a guild."
      actions={
        <>
          <Button variant="ghost" onClick={dismiss}>
            {loadError ? 'Close' : 'Not now'}
          </Button>
          {!loadError && (
            <Button
              disabled={!session || !preview || busy || (historyBlocked && !withoutHistory)}
              onClick={() => void join()}
            >
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
      {preview?.hasHistory &&
        (historyBlocked ? (
          <div className="grid gap-2">
            <Warning>
              {lockHeld
                ? 'This invite includes history, but Hachiman runs in another tab, so this tab cannot open it. Paste the link in that tab (+, then Join with an invite), or close that tab and open the link again.'
                : 'This invite includes history, but encryption does not run in this window, so it cannot open the history.'}{' '}
              If you join here, the invite is used, and you get the history only when a member
              shares it.
            </Warning>
            <label htmlFor={checkId} className="flex items-start gap-2 text-sm">
              <input
                id={checkId}
                type="checkbox"
                className="accent-primary mt-0.5 size-4"
                checked={withoutHistory}
                onChange={(e) => setWithoutHistory(e.target.checked)}
              />
              Join without the history
            </label>
          </div>
        ) : key ? (
          <Warning tone="info">
            This invite includes history. After you join, you can read the earlier messages and
            pages of the channels that everyone in the guild can see.
          </Warning>
        ) : (
          <Warning>
            This invite includes history, but this link does not have its key. Open the full link to
            get the history. If you join without it, you get the history only when a member shares
            it.
          </Warning>
        ))}
      {!session && <SignInPrompt code={code} inviteKey={key} />}
      <ErrorText>{error}</ErrorText>
    </ModalWindow>
  )
}

/** Shown when the invite opens while signed out: sign in first, then accept. */
function SignInPrompt({
  code,
  inviteKey
}: {
  code: string
  inviteKey: string | null
}): React.JSX.Element {
  const { signIn, busy, error } = useSignIn(code, inviteKey)
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
