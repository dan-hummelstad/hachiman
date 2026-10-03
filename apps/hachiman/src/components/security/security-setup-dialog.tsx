import { useCallback, useState } from 'react'
import { ModalWindow } from '@/components/ui/modal-window'
import { OnboardingFlow } from '@/components/security/onboarding'
import { ONBOARDING_TITLES, type OnboardingStep } from '@/components/security/onboarding-steps'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'

/**
 * Dialog kind 'securitySetup': the onboarding flow in a window, at the step that the opener asks
 * for. The window does not close while a new recovery key shows.
 */
export function SecuritySetupDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('securitySetup')
  const state = useCryptoStore((s) => s.status?.state ?? 'needs_identity')
  const [step, setStep] = useState<OnboardingStep>(dialog.mode)
  const [hold, setHold] = useState(false)
  const onHold = useCallback((h: boolean) => setHold(h), [])

  return (
    <ModalWindow
      open={open}
      onClose={() => !hold && close()}
      title={ONBOARDING_TITLES[step]}
      className="sm:max-w-[520px]"
    >
      <div className="max-h-[75vh] overflow-y-auto">
        <OnboardingFlow
          state={state}
          step={step}
          onStep={setStep}
          onHold={onHold}
          onFinished={close}
        />
      </div>
    </ModalWindow>
  )
}
