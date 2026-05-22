import { createContext, useContext, useEffect, type ReactNode } from 'react'
import type { IMumbleServiceFactory } from './IMumbleService'
import type { IPlatformService } from './IPlatformService'
import { registerMumbleServiceFactory } from '../services/platformRegistry'

export interface PlatformContextValue {
  mumble: IMumbleServiceFactory
  platform: IPlatformService
}

const PlatformContext = createContext<PlatformContextValue | null>(null)

interface PlatformProviderProps {
  value: PlatformContextValue
  children: ReactNode
}

/**
 * Wraps the app and supplies platform-specific implementations (Electron or browser).
 * The Electron and browser entry points each construct their own implementations
 * and pass them via `value`.
 *
 * Side effect: on mount, seeds the module-level service registry so non-React,
 * singleton services (ServersService, etc.) can reach the factory without prop drilling.
 */
export function PlatformProvider({ value, children }: PlatformProviderProps): React.JSX.Element {
  // Seed the module-level registry synchronously so services constructed during
  // the first render (e.g. inside event handlers) see the factory immediately.
  registerMumbleServiceFactory(value.mumble)

  useEffect(() => {
    registerMumbleServiceFactory(value.mumble)
  }, [value.mumble])

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
}

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext)
  if (!ctx) {
    throw new Error('usePlatform must be used within a <PlatformProvider>')
  }
  return ctx
}
