import { ImageField } from '@/components/settings/image-field'
import { UserAvatar } from '@/components/shell/user-avatar'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { PROFILE_IMAGE_FORMATS } from '@/services/UploadService'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

/** User settings → My account: profile card, avatar picker and read-only account details. */
export function AccountSection(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  const name = me?.username ?? takusenUser?.handle ?? 'Unknown'

  return (
    <div className="grid gap-8">
      <div className="bg-sidebar border">
        <div className="bg-rail h-16 border-b" />
        <div className="flex items-end gap-4 px-4 pb-4">
          <UserAvatar
            name={name}
            avatar={me?.avatar}
            size={72}
            className="border-sidebar -mt-9 border-4"
          />
          <div className="min-w-0 flex-1 pb-1">
            <p className="truncate text-xl leading-7 font-semibold">{name}</p>
          </div>
        </div>
        <dl className="bg-card mx-4 mb-4 grid gap-4 border p-4">
          <AccountRow label="Username" value={name} mono />
          <AccountRow
            label="Email"
            value={takusenUser?.email || 'Not shared by your Takusen account'}
          />
          {me && <AccountRow label="User ID" value={me.id} mono />}
        </dl>
      </div>
      {me && (
        <ImageField
          label="Avatar"
          hint={`${PROFILE_IMAGE_FORMATS}. Shown as a square.`}
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
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="grid gap-0.5">
      <dt className="section-label">{label}</dt>
      <dd className={cn('truncate', mono ? 'font-mono text-[13px]' : 'text-sm')}>{value}</dd>
    </div>
  )
}
