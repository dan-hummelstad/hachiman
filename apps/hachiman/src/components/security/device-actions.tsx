import { useId } from 'react'
import { MobileField } from '@/components/mobile/field'
import type { RemoveReason } from '@/components/security/device-model'
import { Callout } from '@/components/ui/callout'
import { Field } from '@/components/ui/field'
import { NativeSelect } from '@/components/ui/native-select'
import { cn } from '@/lib/utils'

const REASONS: { value: RemoveReason; label: string }[] = [
  { value: 'user', label: 'I do not use it now' },
  { value: 'lost', label: 'I lost it' },
  { value: 'compromised', label: 'Someone else has it' }
]

/**
 * What "Sign out of this device" does (§12.12), for the desktop confirm. On the mobile layout the
 * M35 sheet (dialog kind `signOut`) is the only way to sign out of this device.
 */
export function SignOutThisDeviceBody({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={cn('grid gap-2', className)}>
      <p>
        This removes this device from your account and deletes its encryption keys. Your other
        devices are not changed.
      </p>
      <p>
        To use encryption here again, you must link this device from another device or use your
        recovery key.
      </p>
    </div>
  )
}

/**
 * What signing out another device does, and the reason picker (§12.12): the desktop confirm and
 * the mobile sheet. `touch` is the mobile kit field, so iOS shows its picker wheel.
 */
export function RemoveDeviceBody({
  reason,
  onReasonChange,
  touch = false,
  className
}: {
  reason: RemoveReason
  onReasonChange: (reason: RemoveReason) => void
  touch?: boolean
  className?: string
}): React.JSX.Element {
  const id = useId()
  // A `MobileField` gives its control the id, so the touch select takes none of its own.
  const select = (
    <NativeSelect
      {...(touch ? {} : { id })}
      size={touch ? 'touch' : 'default'}
      className={touch ? 'flex w-full' : undefined}
      value={reason}
      onChange={(e) => onReasonChange(e.target.value as RemoveReason)}
    >
      {REASONS.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </NativeSelect>
  )
  return (
    <div className={cn('grid gap-3', touch && 'gap-4', className)}>
      <p>
        The device loses access to your account and to new messages. Your other devices get new
        keys.
      </p>
      {touch ? (
        <MobileField id={id} label="Why">
          {select}
        </MobileField>
      ) : (
        <Field id={id} label="Why">
          {select}
        </Field>
      )}
      {reason !== 'user' && (
        <Callout tone="caution" size={touch ? 'touch' : 'default'}>
          The device keeps the messages that it already has. If someone else has it, also change
          your password.
        </Callout>
      )}
    </div>
  )
}
