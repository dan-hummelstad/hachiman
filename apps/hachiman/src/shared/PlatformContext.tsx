import { createContext, useContext, type ReactNode } from 'react'
import type { IPlatformService } from './IPlatformService'

const PlatformContext = createContext<IPlatformService | null>(null)

/** Hosts render `<PlatformProvider value={platformService}><App /></PlatformProvider>`. */
export function PlatformProvider({
  value,
  children
}: {
  value: IPlatformService
  children: ReactNode
}): React.JSX.Element {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePlatform(): IPlatformService {
  const ctx = useContext(PlatformContext)
  if (!ctx) throw new Error('usePlatform must be used within a <PlatformProvider>')
  return ctx
}
