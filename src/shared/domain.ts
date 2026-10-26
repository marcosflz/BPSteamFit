import type { SerializedAppError } from './errors'
import type { InstallerProfile } from './manifest'

export type InstallState =
  | 'available'
  | 'validating'
  | 'extracting'
  | 'installing'
  | 'verifying'
  | 'installed'
  | 'reboot_pending'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ArtworkKind = 'portrait' | 'hero' | 'logo' | 'icon' | 'screenshot'

export const ARTWORK_KINDS: readonly ArtworkKind[] = [
  'portrait',
  'hero',
  'logo',
  'icon',
  'screenshot'
]

export type IdentityStatus = 'none' | 'ambiguous' | 'confirmed' | 'auto'

export interface IdentityCandidate {
  /** Clave estable `provider:providerId`, no un índice de la lista. */
  key: string
  provider: string
  providerId: string
  title: string
  releaseYear?: number
  edition?: string | null
  previewUrl?: string
  verified?: boolean
}

export interface IdentityState {
  status: IdentityStatus
  provider?: string
  providerId?: string
  title?: string
  releaseYear?: number
  decidedBy?: 'manifest' | 'auto' | 'user'
  candidates: IdentityCandidate[]
  updatedAt?: string
  message?: string
}

export interface GameMetadata {
  title: string
  shortDescription?: string
  description?: string
  developers?: string[]
  publishers?: string[]
  releaseDate?: string
  releaseYear?: number
  genres?: string[]
  gameModes?: string[]
  language?: string
  provider: string
  providerId: string
  fetchedAt: string
  /** Datos de fixture local; la UI lo indica para no presentarlos como oficiales. */
  isMock: boolean
}

export interface ArtworkView {
  id: string
  kind: ArtworkKind
  provider: string
  providerGameId?: string
  width?: number
  height?: number
  source: 'provider' | 'manual'
  chosen: boolean
  previewUrl: string
  createdAt: string
  author?: string
  attribution?: string
  license?: string
}

export type ArtworkSet = Partial<Record<ArtworkKind, ArtworkView>>

export interface ArtworkGalleryItem extends ArtworkView {
  selected: boolean
}

export interface VerificationSnapshot {
  ok: boolean
  checkedAt: string
  missingFiles: string[]
  missingDirectories: string[]
}

export interface InstallProgress {
  bytesDone?: number
  bytesTotal?: number
  /** Solo se envía si procede de una fuente fiable; nunca se inventa. */
  percent?: number
  phase: string
  indeterminate: boolean
}

export interface InstallSnapshot {
  state: InstallState
  installDir?: string
  progress?: InstallProgress
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  rebootRequired?: boolean
  /** PID del setup cuando la aplicación pudo observarlo. */
  pid?: number
  logPath?: string
  error?: SerializedAppError
  verification?: VerificationSnapshot
  updatedAt?: string
}

export interface PackageVersionInfo {
  key: string
  version: string
  available: boolean
  importedAt: string
  problem?: string
}

export interface SteamGameState {
  enabled: boolean
  displayName: string
  tags: string[]
  syncState: 'not_installed' | 'none' | 'pending' | 'synced' | 'failed'
  managedShortcutAppId?: number
  lastSyncedAt?: string
}

export interface CatalogGame {
  id: string
  name: string
  edition?: string | null
  currentVersion: string
  packageKey: string
  /** Versión realmente instalada, si existe. */
  installedVersion?: string
  installedPackageKey?: string
  packagePath?: string
  packageAvailable: boolean
  packageProblem?: string
  packageSize?: number
  availableVersions: PackageVersionInfo[]
  installerProfile: InstallerProfile
  requiresElevation: boolean
  install: InstallSnapshot
  identity: IdentityState
  metadata: GameMetadata | null
  artwork: ArtworkSet
  steam: SteamGameState
  updatedAt: string
}

export interface SteamAccount {
  accountId: string
  steamId64?: string
  personaName?: string
  shortcutsPath: string
  isActive: boolean
  isSelected: boolean
}

export type SteamSyncStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export interface SteamSyncResult {
  id: string
  status: SteamSyncStatus
  requestedAt: string
  startedAt?: string
  completedAt?: string
  appliedGameIds: string[]
  backupPath?: string
  error?: SerializedAppError
  steamRestarted?: boolean
}

export interface SteamPendingChange {
  gameId: string
  gameName: string
  action: 'add' | 'update'
  reason: string
  shortcutAppId?: number
}

export interface SteamStatus {
  installed: boolean
  steamPath?: string
  running: boolean
  accounts: SteamAccount[]
  selectedAccountId?: string
  pendingChanges: SteamPendingChange[]
  lastResult?: SteamSyncResult
  warning?: string
}

export interface AppSettings {
  packageFolders: string[]
  installationRoot: string
  metadataProvider: 'mock' | 'steamgriddb'
  referToMetadataInSpanish: boolean
  selectedSteamAccountId?: string
  onboardingCompleted: boolean
}

export interface ProviderStatus {
  mock: { available: true; description: string }
  steamgriddb: {
    configured: boolean
    available: boolean
    description: string
    attribution: string
  }
}

export interface BootstrapData {
  appVersion: string
  platform: string
  settings: AppSettings
  games: CatalogGame[]
  steam: SteamStatus
  providers: ProviderStatus
}

export type SettingsPatch = Partial<
  Pick<
    AppSettings,
    | 'packageFolders'
    | 'installationRoot'
    | 'metadataProvider'
    | 'referToMetadataInSpanish'
    | 'selectedSteamAccountId'
    | 'onboardingCompleted'
  >
>

export interface AppEventMap {
  'install:progress': { gameId: string; snapshot: InstallSnapshot }
  'catalog:changed': { reason: string; gameId?: string }
  'steam:changed': SteamStatus
  'toast': { type: 'info' | 'success' | 'error'; message: string }
}
