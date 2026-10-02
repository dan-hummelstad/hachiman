import { useState } from 'react'

/**
 * `value`, or the last non-null value it had. Lets a dialog keyed on `id | null` keep rendering
 * its content while it animates closed after the id goes null.
 */
export function useLatched<T>(value: T | null | undefined): T | null {
  const [latched, setLatched] = useState<T | null>(value ?? null)
  // Derived state, updated during render (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  if (value != null && value !== latched) setLatched(value)
  return value ?? latched
}
