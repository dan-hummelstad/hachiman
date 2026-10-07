import { Check, Copy } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { ImageField } from '@/components/settings/image-field'
import { UserAvatar } from '@/components/shell/user-avatar'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { PROFILE_IMAGE_FORMATS } from '@/services/UploadService'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

/** User settings → My account (H1): profile card with the account details, and the avatar. */
export function AccountSection(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  const name = me?.username ?? takusenUser?.handle ?? 'Unknown'

  return (
    <div className="grid gap-6">
      <div className="bg-surface-panel border-line-hairline border">
        <div className="from-accent-primary to-accent-primary/50 h-[92px] bg-gradient-to-r" />
        <div className="flex items-end gap-4 px-4">
          <UserAvatar
            name={name}
            avatar={me?.avatar}
            size={96}
            className="ring-surface-panel -mt-12 rounded-full ring-[5px]"
          />
          <p className="text-section-title min-w-0 flex-1 truncate pb-2">{name}</p>
        </div>
        <dl className="divide-line-hairline mt-3 grid divide-y px-4 pb-1">
          <AccountRow label="Username" value={name} mono />
          <AccountRow
            label="Email"
            value={takusenUser?.email || 'Not shared by your Takusen account'}
          />
          {me && <AccountRow label="User ID" value={me.id} mono copy />}
        </dl>
      </div>
      {me && (
        <ImageField
          row
          label="Avatar"
          hint={`${PROFILE_IMAGE_FORMATS}. Shown as a circle.`}
          value={me.avatar}
          fallback={name.slice(0, 1).toUpperCase()}
          onSave={(avatar) => hachiman.rest.updateMe({ avatar })}
        />
      )}
    </div>
  )
}

function AccountRow({
  label,
  value,
  mono,
  copy
}: {
  label: string
  value: string
  mono?: boolean
  /** Shows a copy button. */
  copy?: boolean
}): React.JSX.Element {
  const { copied, copy: copyValue } = useCopy()
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <dt className="section-label">{label}</dt>
        <dd className={cn('truncate', mono ? 'font-mono text-[14px]' : 'text-sm')}>{value}</dd>
      </div>
      {copy && (
        <IconButton
          label={copied !== null ? 'Copied' : `Copy ${label.toLowerCase()}`}
          className="rounded-control border-line-hairline size-8 border"
          onClick={() => copyValue(value)}
        >
          {copied !== null ? <Check className="text-feature-voice-text" /> : <Copy />}
        </IconButton>
      )}
    </div>
  )
}
