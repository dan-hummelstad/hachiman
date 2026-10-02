import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Limits } from '@hachiman/client'

interface LimitsState {
  /** Oracle's upload limits; null until loaded. They are deployment-wide, so sign-out keeps them. */
  limits: Limits | null
}

export const useLimitsStore = create<LimitsState>()(devtools(() => ({ limits: null })))
