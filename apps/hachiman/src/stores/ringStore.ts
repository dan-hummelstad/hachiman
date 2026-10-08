import { create } from 'zustand'
import type { IncomingRing } from '@/lib/call-ring'

/** The incoming DM call that rings on this device (one at a time). Written only by CallRingService. */
export const useRingStore = create<{ ring: IncomingRing | null }>()(() => ({ ring: null }))
