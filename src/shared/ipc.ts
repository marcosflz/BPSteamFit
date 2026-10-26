import type {
  AppEventMap,
  AppSettings,
  ArtworkGalleryItem,
  ArtworkKind,
  BootstrapData,
  CatalogGame,
  InstallSnapshot,
  ProviderStatus,
  SettingsPatch,
  SteamAccount,
  SteamStatus
} from './domain'
import type { SerializedAppError } from './errors'

export const IPC = {
  bootstrap: 'app:bootstrap',
  refreshCatalog: 'catalog:refresh',
  rescanPackages: 'catalog:rescan',
  importPackageFile: 'catalog:import-file',
  addPackageFolder: 'settings:add-package-folder',
  chooseInstallationRoot: 'settings:choose-installation-root',
  updateSettings: 'settings:update',
  chooseInstallFolder: 'install:choose-folder',
  startInstall: 'install:start',
  cancelOperation: 'install:cancel',
  revalidateInstall: 'install:revalidate',
  launchGame: 'game:launch',
  revealGame: 'game:reveal',
  refreshMetadata: 'metadata:refresh',
  searchIdentity: 'metadata:search',
  chooseIdentity: 'metadata:choose-identity',
  clearIdentity: 'metadata:clear-identity',
  artworkGallery: 'artwork:gallery',
  selectArtwork: 'artwork:select',
  importLocalArtwork: 'artwork:import-local',
  resetArtwork: 'artwork:reset',
  providerStatus: 'providers:status',
  setSteamGridDbKey: 'providers:set-key',
  clearSteamGridDbKey: 'providers:clear-key',
  refreshAccounts: 'steam:accounts',
  selectSteamAccount: 'steam:select-account',
  prepareSteamSync: 'steam:prepare-sync',
  startSteamSync: 'steam:start-sync',
  getSteamStatus: 'steam:status',
  openLogFolder: 'app:open-log-folder',
  openPath: 'app:open-path',
  quit: 'app:quit',
  event: 'app:event'
} as const

export interface ResultEnvelope<T> {
  ok: boolean
  data?: T
  error?: SerializedAppError
}

export interface StartInstallRequest {
  gameId: string
  installDir?: string
}

export interface StartInstallResult {
  snapshot: InstallSnapshot
}

export interface SteamSyncStartResult {
  scheduled: boolean
  message: string
  result?: unknown
}

export interface BpsApi {
  getBootstrap(): Promise<BootstrapData>
  refreshCatalog(): Promise<CatalogGame[]>
  rescanPackages(): Promise<CatalogGame[]>
  importPackageFile(): Promise<CatalogGame | null>
  addPackageFolder(): Promise<AppSettings | null>
  chooseInstallationRoot(): Promise<AppSettings | null>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  chooseInstallFolder(gameId: string): Promise<string | null>
  startInstall(request: StartInstallRequest): Promise<StartInstallResult>
  cancelOperation(gameId: string): Promise<void>
  revalidateInstall(gameId: string): Promise<CatalogGame>
  launchGame(gameId: string): Promise<void>
  revealGame(gameId: string): Promise<void>
  refreshMetadata(gameId: string): Promise<CatalogGame>
  searchIdentity(gameId: string, query: string): Promise<CatalogGame>
  chooseIdentity(gameId: string, candidateKey: string): Promise<CatalogGame>
  clearIdentity(gameId: string): Promise<CatalogGame>
  getArtworkGallery(gameId: string, kind: ArtworkKind): Promise<ArtworkGalleryItem[]>
  selectArtwork(gameId: string, kind: ArtworkKind, artworkId: string): Promise<CatalogGame>
  importLocalArtwork(gameId: string, kind: ArtworkKind): Promise<CatalogGame | null>
  resetArtwork(gameId: string, kind: ArtworkKind): Promise<CatalogGame>
  getProviderStatus(): Promise<ProviderStatus>
  setSteamGridDbKey(key: string): Promise<ProviderStatus>
  clearSteamGridDbKey(): Promise<ProviderStatus>
  refreshSteamAccounts(): Promise<SteamAccount[]>
  selectSteamAccount(accountId: string): Promise<SteamStatus>
  prepareSteamSync(): Promise<SteamStatus>
  startSteamSync(confirmed: boolean): Promise<SteamSyncStartResult>
  getSteamStatus(): Promise<SteamStatus>
  openLogFolder(): Promise<void>
  openPath(path: string, purpose: 'log' | 'install-dir' | 'package'): Promise<void>
  quit(): Promise<void>
  onEvent(listener: (event: { type: keyof AppEventMap; payload: AppEventMap[keyof AppEventMap] }) => void): () => void
}

export function isResultEnvelope<T>(value: unknown): value is ResultEnvelope<T> {
  return Boolean(value && typeof value === 'object' && 'ok' in value)
}
