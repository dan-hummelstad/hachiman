const UNITS = ['KB', 'MB', 'GB']

/** `812 B`, `4.2 MB`, `25 MB` (binary units, the way Takusen's limit is defined). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${shown} ${UNITS[unit]}`
}
