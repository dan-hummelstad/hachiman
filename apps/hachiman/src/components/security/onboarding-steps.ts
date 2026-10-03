/** The steps of the identity onboarding (onboarding.tsx). */
export type OnboardingStep = 'choose' | 'setup' | 'link' | 'restore' | 'reset'

export const ONBOARDING_TITLES: Record<OnboardingStep, string> = {
  choose: 'Set up encryption on this device',
  setup: 'Set up this device',
  link: 'Link from another device',
  restore: 'Restore with recovery key',
  reset: 'Reset my keys'
}
