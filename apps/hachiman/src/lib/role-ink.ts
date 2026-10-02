/**
 * Role colours are picked against dark surfaces; on light ones the paler hues (pink, lilac,
 * cyan) wash out. Inside a ROLE_INK_SCOPE element `roleInk` pulls them 35% toward the
 * foreground in light mode and leaves them untouched in dark.
 */
export const ROLE_INK_SCOPE = '[--role-ink:35%] dark:[--role-ink:0%]'

export const roleInk = (color: string | undefined): string | undefined =>
  color && `color-mix(in oklab, ${color}, var(--foreground) var(--role-ink, 0%))`
