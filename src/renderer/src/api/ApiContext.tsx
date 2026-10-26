import { createContext, useContext, type ReactNode } from 'react'
import type { BpsApi } from '@shared/ipc'

const ApiContext = createContext<BpsApi | null>(null)

export function ApiProvider(props: { api: BpsApi; children: ReactNode }): React.JSX.Element {
  return <ApiContext.Provider value={props.api}>{props.children}</ApiContext.Provider>
}

export function useApi(): BpsApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiContext no está disponible.')
  return api
}
