import { useEffect, useId, useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
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
      description="You’ve been invited to join a guild"
      icon={<Link2 />}
      feature="voice"
      actions={
        <>
          <Button variant="quiet" onClick={dismiss}>
            {loadError ? 'Close' : 'Not now'}
          </Button>
          {!loadError && (
            <Button
              disabled={!session || !preview || busy || (historyBlocked && !withoutHistory)}
              onClick={() => void join()}
            >
              <Check />
              {busy ? 'Joining…' : 'Accept invite'}
            </Button>
          )}
        </>
      }
    >
      <div className="border-line-hairline bg-surface-raised overflow-hidden border">
        <div
          aria-hidden
          className="from-accent-primary/70 to-feature-page/40 h-[70px] bg-gradient-to-r"
        />
        <div className="flex items-end gap-3.5 px-4 pb-4">
          {preview ? (
            <>
              <GuildTile
                guild={preview.guild}
                size="lg"
                className="border-surface-raised -mt-7 border-4"
              />
              <span className="grid min-w-0 gap-0.5 pb-0.5">
                <span className="text-heading truncate">{preview.guild.name}</span>
                <span className="text-meta text-text-secondary flex items-center gap-1.5 tabular-nums">
                  <span aria-hidden className="bg-text-tertiary size-2 rounded-full" />
                  {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
                </span>
              </span>
            </>
          ) : loadError ? (
            <span className="grid gap-1 pt-3">
              <span className="text-label">This invite doesn’t work</span>
              <span className="text-meta text-text-secondary">
                It may have expired or been revoked ({loadError}). Ask whoever sent it for a new
                one.
              </span>
            </span>
          ) : (
            <>
              <Skeleton className="-mt-7 size-14 shrink-0 rounded-full" />
              <span className="grid flex-1 gap-2" aria-label="Loading invite">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </span>
            </>
          )}
        </div>
      </div>
      <p className="text-meta text-text-secondary flex items-center gap-2">
        Invite code
        <span className="bg-surface-sunken text-text-primary px-2 py-0.5 font-mono text-[13px] font-semibold">
          {code}
        </span>
        {preview?.expiresAt && <span className="ml-auto">{expiresIn(preview.expiresAt)}</span>}
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
              <Checkbox
                id={checkId}
                className="mt-0.5"
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
      <div className="border-line-hairline bg-surface-raised flex items-center gap-3 border p-3">
        <span className="flex-1 text-sm">Sign in with Takusen to accept this invite.</span>
        <Button size="sm" disabled={busy} onClick={() => void signIn()}>
          {busy ? 'Opening…' : 'Sign in'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

/** "Expires in 6 days", "Expires in 3 hours", "Expires soon". */
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 48) return `Expires in ${Math.floor(hours / 24)} days`
  if (hours >= 2) return `Expires in ${hours} hours`
  return 'Expires soon'
}
