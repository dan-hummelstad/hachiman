/**
 * The option index after an arrow key in a radio group of `n` options (WAI-ARIA radio group):
 * Right and Down move on, Left and Up move back, both wrap. Null for any other key.
 */
export function radioStep(index: number, n: number, key: string): number | null {
  if (n <= 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % n
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + n) % n
  if (key === 'Home') return 0
  if (key === 'End') return n - 1
  return null
}
