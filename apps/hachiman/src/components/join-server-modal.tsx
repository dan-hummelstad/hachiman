import { useEffect, useId, useState } from 'react'
import { Check, Link2, Lock } from 'lucide-react'
import type { InvitePreview } from '@hachiman/client'
import { useOwnDevices } from '@/components/security/devices-panel'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { GuildTile } from '@/components/ui/guild-tile'
import { ModalWindow } from '@/components/ui/modal-window'
import { Skeleton } from '@/components/ui/skeleton'
import { useAction } from '@/hooks/use-action'
import { useKeyedAsync } from '@/hooks/use-keyed-async'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView } from '@/hooks/use-member'
import { useSignIn } from '@/hooks/use-sign-in'
import { inviteFromLine, inviteKeysLine } from '@/lib/guild-invite'
import {
  acceptInvite,
  peekInviteKey,
  previewInvite,
  stashInviteKey
} from '@/services/InviteService'
import { useChannelStore } from '@/stores/channelStore'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialog, type InviteFrom } from '@/stores/dialogStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { Callout } from '@/components/ui/callout'

/**
 * Opened by an invite deep link: preview the guild, then accept. The key of an invite with history
 * (`#k=`) comes from InviteService memory and stays in component state (§12.17). When encryption
 * cannot run in this window (another tab holds the crypto store, for example), the join would use
 * the invite without the history: the user must agree to that first. On the mobile layout it is a
 * sheet (M45): an invite link tapped in a message names its sender in the subtitle, and a line
 * names the own devices that get the guild's keys.
 */
export function JoinServerModal(): React.JSX.Element {
  const {
    dialog: { code, from },
    open,
    close
  } = useDialog('joinInvite')
  const mobile = useLayout() === 'mobile'
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
  const fromLine = useInviteFromLine(from)
  const callout = mobile ? 'touch' : 'default'

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
      description={fromLine ?? 'You’ve been invited to join a guild'}
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
      <InviteCard preview={preview} loadError={loadError} />
      <p className="text-meta text-text-secondary mobile:text-[13px] mobile:font-medium mobile:text-text-tertiary flex items-center gap-2">
        <span className="mobile:text-[13.5px] mobile:font-semibold shrink-0">Invite code</span>
        <span className="bg-surface-sunken text-text-primary mobile:flex mobile:h-7 mobile:items-center mobile:bg-surface-hover mobile:px-[9px] mobile:text-[14px] min-w-0 truncate px-2 py-0.5 font-mono text-[13px] font-semibold">
          {code}
        </span>
        {preview?.expiresAt && (
          <span className="ml-auto shrink-0">{expiresIn(preview.expiresAt)}</span>
        )}
      </p>
      {mobile && preview && <KeysLine guildName={preview.guild.name} />}
      {preview?.hasHistory &&
        (historyBlocked ? (
          <div className="grid gap-2">
            <Callout tone="caution" size={callout}>
              {lockHeld
                ? 'This invite includes history, but Hachiman runs in another tab, so this tab cannot open it. Paste the link in that tab (+, then Join with an invite), or close that tab and open the link again.'
                : 'This invite includes history, but encryption does not run in this window, so it cannot open the history.'}{' '}
              If you join here, the invite is used, and you get the history only when a member
              shares it.
            </Callout>
            <label
              htmlFor={checkId}
              className="mobile:min-h-11 mobile:items-center mobile:gap-3 mobile:text-[15px] mobile:font-semibold flex items-start gap-2 text-sm"
            >
              <Checkbox
                id={checkId}
                size={mobile ? 'lg' : 'default'}
                className="mobile:mt-0 mt-0.5"
                checked={withoutHistory}
                onChange={(e) => setWithoutHistory(e.target.checked)}
              />
              Join without the history
            </label>
          </div>
        ) : key ? (
          <Callout tone="info" size={callout}>
            This invite includes history. After you join, you can read the earlier messages and
            pages of the channels that everyone in the guild can see.
          </Callout>
        ) : (
          <Callout tone="caution" size={callout}>
            This invite includes history, but this link does not have its key. Open the full link to
            get the history. If you join without it, you get the history only when a member shares
            it.
          </Callout>
        ))}
      {!session && <SignInPrompt code={code} inviteKey={key} />}
      <ErrorText>{error}</ErrorText>
    </ModalWindow>
  )
}

/**
 * The guild of an invite as a small card: a banner (a placeholder until guilds have banners), the
 * icon overlapping it, the name and the member count. While the preview loads, skeletons; when it
 * fails, why. On the mobile layout it takes the sizes of M45: banner 84, icon 64 with a 4 ring in
 * the card colour, name 20.
 */
function InviteCard({
  preview,
  loadError
}: {
  preview: InvitePreview | null
  loadError: string | null
}): React.JSX.Element {
  return (
    <div className="border-line-hairline bg-surface-raised mobile:border-line-strong mobile:bg-surface-sunken shrink-0 overflow-hidden border">
      <div
        aria-hidden
        className="from-accent-primary/70 to-feature-page/40 mobile:h-[84px] h-[70px] bg-gradient-to-r"
      />
      <div className="mobile:items-start mobile:gap-3 mobile:px-3 flex items-end gap-3.5 px-4 pb-4">
        {preview ? (
          <>
            <GuildTile
              guild={preview.guild}
              size="lg"
              className="border-surface-raised mobile:border-surface-sunken mobile:-mt-[38px] mobile:size-[72px] mobile:text-[22px] mobile:font-extrabold -mt-7 border-4"
            />
            <span className="mobile:gap-[5px] mobile:pt-3 mobile:pb-0 grid min-w-0 gap-0.5 pb-0.5">
              <span className="text-heading mobile:text-[20px] mobile:leading-6 truncate">
                {preview.guild.name}
              </span>
              <span className="text-meta text-text-secondary mobile:text-[13.5px] mobile:leading-4 mobile:font-semibold flex items-center gap-1.5 tabular-nums">
                <span
                  aria-hidden
                  className="bg-text-tertiary mobile:size-[7px] size-2 shrink-0 rounded-full"
                />
                {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
              </span>
            </span>
          </>
        ) : loadError ? (
          <span className="mobile:px-1 grid gap-1 pt-3">
            <span className="text-label">This invite doesn’t work</span>
            <span className="text-meta text-text-secondary">
              It may have expired or been revoked ({loadError}). Ask whoever sent it for a new one.
            </span>
          </span>
        ) : (
          <>
            <Skeleton className="mobile:-mt-[38px] mobile:size-[72px] -mt-7 size-14 shrink-0 rounded-full" />
            <span className="mobile:pt-3 grid flex-1 gap-2" aria-label="Loading invite">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/** "From marlowe, in your DMs" for an invite link tapped in a message; null otherwise. */
function useInviteFromLine(from: InviteFrom | undefined): string | null {
  const channel = useChannelStore((s) => (from ? s.channels.get(from.channelId) : undefined))
  const { name } = useMemberView(channel?.guildId, from?.userId ?? '')
  return from ? inviteFromLine(name, channel) : null
}

/**
 * The E2EE line of M45: the guild is end-to-end encrypted, and the own active devices get its keys
 * at the join. The count shows once encryption is ready.
 */
function KeysLine({ guildName }: { guildName: string }): React.JSX.Element {
  const ready = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const { devices } = useOwnDevices(ready)
  const active = devices ? devices.filter((d) => d.status === 'active').length : null
  return (
    <p className="text-text-tertiary flex gap-2 text-[13px] leading-[1.5] font-medium">
      <Lock aria-hidden className="text-feature-voice-text mt-[3px] size-3.5 shrink-0" />
      {inviteKeysLine(guildName, active)}
    </p>
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
        <Button
          size="sm"
          className="mobile:h-9 mobile:px-3.5 mobile:text-[14px] mobile:font-bold"
          disabled={busy}
          onClick={() => void signIn()}
        >
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
