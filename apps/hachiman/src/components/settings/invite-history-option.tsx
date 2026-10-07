import { useId } from 'react'
import { History } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { Warning } from '@/components/security/screen-window'
import { Switch } from '@/components/ui/switch'

/**
 * "Include history" of an administrator's invite (§12.11.4), and its scope: the channels that
 * @everyone can view (`inviteScope`). A channel with the history visibility `joined` is marked,
 * because the invite gives its history too.
 */
export function InviteHistoryOption({
  checked,
  onChange,
  scope
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  scope: readonly Channel[]
}): React.JSX.Element {
  const id = useId()
  const joined = scope.some((c) => c.historyVisibility === 'joined')
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="flex items-center gap-3 py-1">
        <History aria-hidden className="text-text-tertiary size-4 shrink-0" />
        <span className="grid min-w-0 flex-1">
          <span className="text-label text-text-primary">Include history</span>
          <span className="text-meta text-text-tertiary">
            {scope.length === 0
              ? 'No text or pages channel is visible to everyone, so an invite cannot include history.'
              : 'The new member can read the earlier messages and pages of the public channels.'}
          </span>
        </span>
        <Switch
          id={id}
          checked={checked}
          disabled={scope.length === 0}
          onCheckedChange={onChange}
        />
      </label>
      {checked && scope.length > 0 && (
        <Warning>
          Anyone who gets this link can read the earlier messages and the pages of these channels:{' '}
          {scope.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              <span className="font-semibold">#{c.name ?? c.id}</span>
              {c.historyVisibility === 'joined' && ' (joined)'}
            </span>
          ))}
          .
          {joined &&
            ' A channel marked "joined" shows its history only to members who were there. This invite gives its history too.'}
        </Warning>
      )}
    </div>
  )
}
