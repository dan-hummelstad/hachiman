import { NativeSelect } from '@/components/ui/native-select'
import { useRecommendedRegion } from '@/hooks/use-recommended-region'

/**
 * Voice-region picker. `''` is "Automatic"; its label names the measured recommendation, if any.
 * Other props (`id`, `className`, `size`, `lead`, `disabled`) go to the `NativeSelect`. Inside a
 * `MobileField`, leave out `id`: the field gives it.
 */
export function RegionSelect({
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof NativeSelect>, 'value' | 'onChange' | 'children'> & {
  value: string
  onChange: (region: string) => void
}): React.JSX.Element {
  const { regions, recommended } = useRecommendedRegion()
  return (
    <NativeSelect {...props} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">
        {recommended ? `Automatic (recommended: ${recommended.displayName})` : 'Automatic'}
      </option>
      {regions.map((r) => (
        <option key={r.code} value={r.code}>
          {r.displayName}
        </option>
      ))}
      {/* Keep the current value selectable while the region list loads (or if it vanished). */}
      {value && !regions.some((r) => r.code === value) && <option value={value}>{value}</option>}
    </NativeSelect>
  )
}
