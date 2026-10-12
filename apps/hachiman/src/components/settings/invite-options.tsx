import { useId } from 'react'
import { ChevronsUpDown, Hourglass, Users } from 'lucide-react'
import { MobileField } from '@/components/mobile/field'
import { Field } from '@/components/ui/field'
import { NativeSelect } from '@/components/ui/native-select'
import { INVITE_MAX_USES, inviteExpiryChoices, maxUsesLabel } from '@/components/settings/invites'
import type { InviteOptionsValue } from '@/services/InviteService'

/**
 * "Expire after" + "Max uses" selects for a new invite. Only an administrator gets choices above
 * 24 hours, and "Permanent".
 *
 * `fields` (default): two Fields; the parent lays them out. `boxes`: the mobile create bar (M55),
 * two 52 select boxes side by side, each with its label inside. `touch`: the mobile invite sheet
 * (M46), two touch selects with lead icons under their field labels. Both mobile layouts stack
 * when the two do not fit at 152 px each.
 */
export function InviteOptions({
  value,
  onChange,
  isAdmin,
  layout = 'fields'
}: {
  value: InviteOptionsValue
  onChange: (value: InviteOptionsValue) => void
  isAdmin: boolean
  layout?: 'fields' | 'boxes' | 'touch'
}): React.JSX.Element {
  const id = useId()
  const choices = inviteExpiryChoices(isAdmin)
  const expiryOptions = choices.map((o) => (
    <option key={o.seconds} value={o.seconds}>
      {o.label}
    </option>
  ))
  const usesOptions = INVITE_MAX_USES.map((n) => (
    <option key={n} value={n}>
      {maxUsesLabel(n)}
    </option>
  ))
  const setExpiry = (e: React.ChangeEvent<HTMLSelectElement>): void =>
    onChange({ ...value, expiry: Number(e.target.value) })
  const setUses = (e: React.ChangeEvent<HTMLSelectElement>): void =>
    onChange({ ...value, maxUses: Number(e.target.value) })

  if (layout === 'boxes') {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2.5">
        <SelectBox
          id={`${id}-expiry`}
          label="Expire after"
          shown={choices.find((c) => c.seconds === value.expiry)?.label ?? ''}
          value={value.expiry}
          onChange={setExpiry}
        >
          {expiryOptions}
        </SelectBox>
        <SelectBox
          id={`${id}-uses`}
          label="Max uses"
          shown={maxUsesLabel(value.maxUses)}
          value={value.maxUses}
          onChange={setUses}
        >
          {usesOptions}
        </SelectBox>
      </div>
    )
  }

  if (layout === 'touch') {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
        <MobileField id={`${id}-expiry`} label="Expire after">
          <NativeSelect
            size="touch"
            lead={<Hourglass />}
            className="w-full"
            value={value.expiry}
            onChange={setExpiry}
          >
            {expiryOptions}
          </NativeSelect>
        </MobileField>
        <MobileField id={`${id}-uses`} label="Max uses">
          <NativeSelect
            size="touch"
            lead={<Users />}
            className="w-full"
            value={value.maxUses}
            onChange={setUses}
          >
            {usesOptions}
          </NativeSelect>
        </MobileField>
      </div>
    )
  }

  return (
    <>
      <Field id={`${id}-expiry`} label="Expire after">
        <NativeSelect id={`${id}-expiry`} value={value.expiry} onChange={setExpiry}>
          {expiryOptions}
        </NativeSelect>
      </Field>
      <Field id={`${id}-uses`} label="Max uses">
        <NativeSelect id={`${id}-uses`} value={value.maxUses} onChange={setUses}>
          {usesOptions}
        </NativeSelect>
      </Field>
    </>
  )
}

/**
 * One 52 select box (M55): the label (11.5/700) over the value (15/600), chevrons at the end. A
 * clear native <select> covers the whole box, so a tap opens the iOS picker wheel.
 */
function SelectBox({
  id,
  label,
  shown,
  value,
  onChange,
  children
}: {
  id: string
  label: string
  /** The label of the picked option. */
  shown: string
  value: number
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-control border-line-strong bg-surface-sunken has-[select:focus-visible]:border-line-focus has-[select:focus-visible]:ring-line-focus relative flex h-[52px] min-w-0 items-center gap-2 border pr-3 pl-3.5 has-[select:focus-visible]:ring-[0.5px]">
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <label
          htmlFor={id}
          className="text-text-tertiary truncate text-[11.5px] leading-[14px] font-bold"
        >
          {label}
        </label>
        <span
          aria-hidden
          className="text-text-primary truncate text-[15px] leading-5 font-semibold"
        >
          {shown}
        </span>
      </span>
      <ChevronsUpDown aria-hidden className="text-text-tertiary size-4 shrink-0" />
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 outline-none"
      >
        {children}
      </select>
    </div>
  )
}
