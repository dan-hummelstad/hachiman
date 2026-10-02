import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** The human part of a thrown value, for "Could not …: <errMsg>" lines. */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
