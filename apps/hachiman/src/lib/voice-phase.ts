import type { VoiceConnectionState } from '@/stores/voiceStore'

export type Phase = 'connected' | 'lost' | 'connecting'

/** The first line of the voice dock and the voice bar per phase, and its colour. */
export const PHASE: Record<Phase, { label: string; className: string }> = {
  connected: { label: 'Voice connected', className: 'text-live-text' },
  lost: { label: 'Connection lost', className: 'text-you-text' },
  connecting: { label: 'Connecting…', className: 'text-text-secondary' }
}

/** The phase that the voice dock and the voice bar show for a connection state. */
export function phaseOf(state: VoiceConnectionState): Phase {
  if (state === 'connected') return 'connected'
  return state === 'failed' || state === 'disconnected' ? 'lost' : 'connecting'
}
