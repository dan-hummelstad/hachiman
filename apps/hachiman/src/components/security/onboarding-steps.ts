import { createContext, useContext } from 'react'
import { useLayout } from '@/hooks/use-layout'
import { useMediaQuery } from '@/hooks/use-media-query'
import { usePlatform } from '@/shared/PlatformContext'

/** The steps of the identity onboarding (onboarding.tsx). */
export type OnboardingStep = 'choose' | 'setup' | 'link' | 'restore' | 'reset'

/** The step titles in a dialog (desktop, and the set-up window from settings). */
export const ONBOARDING_TITLES: Record<OnboardingStep, string> = {
  choose: 'Set up encryption on this device',
  setup: 'Set up this device',
  link: 'Link from another device',
  restore: 'Restore with recovery key',
  reset: 'Reset my keys'
}

/** What the set-up screens call this device. */
export type DeviceNoun = 'phone' | 'device'

/**
 * 'phone' in the iOS app and on a touch screen with the mobile layout (a phone browser). A narrow
 * desktop window keeps 'device'.
 */
export function deviceNoun(facts: { ios: boolean; mobile: boolean; coarse: boolean }): DeviceNoun {
  return facts.ios || (facts.mobile && facts.coarse) ? 'phone' : 'device'
}

export function useDeviceNoun(): DeviceNoun {
  const ios = usePlatform().platform === 'ios'
  const mobile = useLayout() === 'mobile'
  const coarse = useMediaQuery('(pointer: coarse)')
  return deviceNoun({ ios, mobile, coarse })
}

/** The Nav Bar titles of the set-up screens (M16 to M20): short, with the device noun. */
export function screenTitle(step: OnboardingStep, noun: DeviceNoun): string {
  switch (step) {
    case 'choose':
      return `Set up this ${noun}`
    case 'link':
      return `Link this ${noun}`
    case 'restore':
      return 'Restore with recovery key'
    case 'setup':
      return 'Start a new identity'
    case 'reset':
      return 'Reset my keys'
  }
}

/**
 * Where a security step renders: 'dialog' (desktop, and sheets on mobile) or 'screen' (the
 * mobile set-up gate, `StepScreen`). The value is the element that takes the step's Nav Bar.
 */
export const StepScreenContext = createContext<{ nav: HTMLElement | null } | null>(null)

export type StepLayout = 'dialog' | 'screen'

export function useStepLayout(): StepLayout {
  return useContext(StepScreenContext) ? 'screen' : 'dialog'
}

/** The title of a step in the layout that it renders in. */
export function useStepTitles(): (step: OnboardingStep) => string {
  const screen = useStepLayout() === 'screen'
  const noun = useDeviceNoun()
  return (step) => (screen ? screenTitle(step, noun) : ONBOARDING_TITLES[step])
}

/** What the server says about the account, for the choice of steps. */
export interface AccountFacts {
  /** The account has a current master key: set up is not possible, link or restore is. */
  hasMaster: boolean
  /** No current master key and devices revoked by a password reset (§12.4 "Password reset"). */
  passwordReset: boolean
}

/** The set-up paths of M16, in their order on the screen. */
export const SETUP_PATHS = ['link', 'restore', 'setup'] as const
export type SetupPath = (typeof SETUP_PATHS)[number]

/**
 * The suggested path: Link while the facts load or fail and when the account has a key, Restore
 * after a password reset, Start new for the first device.
 */
export function recommendedPath(facts: AccountFacts | null): SetupPath {
  if (facts === null || facts.hasMaster) return 'link'
  return facts.passwordReset ? 'restore' : 'setup'
}

/**
 * A path that cannot work for this account. Start new needs an account with no key. After a
 * password reset no device and no key are left: only Restore, or the reset line.
 */
export function pathDisabled(path: SetupPath, facts: AccountFacts | null): boolean {
  if (facts === null) return false
  switch (path) {
    case 'link':
      return facts.passwordReset
    case 'restore':
      return false
    case 'setup':
      return facts.hasMaster || facts.passwordReset
  }
}

/**
 * The selected path: the user's pick while it can work, else the suggested one. So the default
 * follows the facts until the user picks, and a pick stays.
 */
export function selectedPath(pick: SetupPath | null, facts: AccountFacts | null): SetupPath {
  return pick !== null && !pathDisabled(pick, facts) ? pick : recommendedPath(facts)
}

/** Whole seconds until `expiresAt` (ms), never below 0. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/** "9:48" for 588 seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
