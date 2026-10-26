import { createContext, useContext } from 'react'
import type {
  AppSettings,
  CatalogGame,
  ProviderStatus,
  SteamStatus
} from '@shared/domain'
import type { BpsApi } from '@shared/ipc'
import type { AppDialog } from '../navigation/dialogs'
import type { Screen } from '../navigation/screens'

export type ToastTone = 'info' | 'success' | 'error'

export interface AppRuntime {
  api: BpsApi
  appVersion: string
  platform: string
  settings: AppSettings
  providers: ProviderStatus
  steam: SteamStatus
  games: CatalogGame[]
  connected: boolean
  screen: Screen
  navigate: (screen: Screen) => void
  back: () => void
  updateGame: (game: CatalogGame) => void
  updateSettings: (settings: AppSettings) => void
  updateSteam: (steam: SteamStatus) => void
  updateProviders: (providers: ProviderStatus) => void
  refreshCatalog: () => Promise<CatalogGame[]>
  rescanPackages: () => Promise<CatalogGame[]>
  toast: (tone: ToastTone, message: string) => void
  openDialog: (dialog: AppDialog) => void
  closeDialog: () => void
}

export const AppRuntimeContext = createContext<AppRuntime | null>(null)

export function useRuntime(): AppRuntime {
  const value = useContext(AppRuntimeContext)
  if (!value) {
    throw new Error('AppRuntimeContext no está disponible.')
  }
  return value
}
