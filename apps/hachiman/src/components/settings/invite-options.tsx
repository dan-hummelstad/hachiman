import { useId } from 'react'
import { Field } from '@/components/ui/field'
import { NativeSelect } from '@/components/ui/native-select'
import { INVITE_EXPIRY, INVITE_MAX_USES } from '@/components/settings/invites'
import type { InviteOptionsValue } from '@/services/InviteService'

/** "Expire after" + "Max uses" selects for a new invite. Two Fields; the parent lays them out. */
export function InviteOptions({
  value,
  onChange
}: {
  value: InviteOptionsValue
  onChange: (value: InviteOptionsValue) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <>
      <Field id={`${id}-expiry`} label="Expire after">
        <NativeSelect
          id={`${id}-expiry`}
          value={value.expiry}
          onChange={(e) => onChange({ ...value, expiry: Number(e.target.value) })}
        >
          {INVITE_EXPIRY.map((o) => (
            <option key={o.seconds} value={o.seconds}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={`${id}-uses`} label="Max uses">
        <NativeSelect
          id={`${id}-uses`}
          value={value.maxUses}
          onChange={(e) => onChange({ ...value, maxUses: Number(e.target.value) })}
        >
          {INVITE_MAX_USES.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'No limit' : `${n} ${n === 1 ? 'use' : 'uses'}`}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </>
  )
}
