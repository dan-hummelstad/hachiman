/**
 * The height of a bottom sheet (spec §2.5, §2.12). Its top stops 8 px under the status bar and it
 * follows `--app-height`, so with the keyboard up it ends at the keyboard.
 */
export const SHEET_MAX_H = 'max-h-[calc(var(--app-height,100dvh)-var(--safe-top,0px)-8px)]'

/**
 * fit: the sheet takes its content's height, up to the max. full: the iOS large detent, always
 * the max height. Use it for content that fills the rest of the sheet with `flex-1` (the emoji
 * grid): in a sheet with no definite height, iOS WebKit gives such a child 0 px.
 */
export const SHEET_SIZE = {
  fit: '',
  full: 'h-[calc(var(--app-height,100dvh)-var(--safe-top,0px)-8px)]'
} as const

export type SheetSize = keyof typeof SHEET_SIZE
