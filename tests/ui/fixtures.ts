import type {
  AppSettings,
  ArtworkGalleryItem,
  ArtworkKind,
  ArtworkView,
  BootstrapData,
  CatalogGame,
  IdentityCandidate,
  IdentityState,
  InstallSnapshot,
  InstallState,
  ProviderStatus,
  SteamAccount,
  SteamStatus,
  SteamSyncResult
} from '@shared/domain'

const NOW = '2026-10-20T18:30:00.000Z'

export function makeSnapshot(
  state: InstallState = 'available',
  partial: Partial<InstallSnapshot> = {}
): InstallSnapshot {
  return {
    state,
    updatedAt: NOW,
    ...partial
  }
}

export function makeCandidate(partial: Partial<IdentityCandidate> = {}): IdentityCandidate {
  return {
    key: 'mock:hollow-signal',
    provider: 'mock',
    providerId: 'hollow-signal',
    title: 'Hollow Signal',
    releaseYear: 2025,
    verified: true,
    ...partial
  }
}

export function makeArtwork(partial: Partial<ArtworkView> = {}): ArtworkView {
  return {
    id: 'art-1',
    kind: 'portrait',
    provider: 'SteamGridDB',
    width: 600,
    height: 900,
    source: 'provider',
    chosen: true,
    previewUrl: 'bps-media://artwork/portrait-1',
    createdAt: NOW,
    ...partial
  }
}

export function makeGalleryItem(
  partial: Partial<ArtworkGalleryItem> = {}
): ArtworkGalleryItem {
  return { ...makeArtwork(partial), selected: false, ...partial }
}

export function makeGame(partial: Partial<CatalogGame> = {}): CatalogGame {
  const base: CatalogGame = {
    id: 'hollow-signal',
    name: 'Hollow Signal',
    edition: null,
    currentVersion: '1.0.0',
    packageKey: 'pkg-hollow-1',
    packagePath: 'C:\\Users\\Player\\BPSteamFit\\Packages\\HollowSignal.game',
    packageAvailable: true,
    packageSize: 1_610_612_736,
    availableVersions: [
      {
        key: 'pkg-hollow-1',
        version: '1.0.0',
        available: true,
        importedAt: NOW
      }
    ],
    installerProfile: 'demo',
    requiresElevation: false,
    install: makeSnapshot('available'),
    identity: { status: 'none', candidates: [] },
    metadata: null,
    artwork: {},
    steam: {
      enabled: true,
      displayName: 'Hollow Signal',
      tags: ['BPSteamFit'],
      syncState: 'none'
    },
    updatedAt: NOW
  }

  return {
    ...base,
    ...partial,
    install: partial.install ?? base.install,
    identity: partial.identity
      ? { ...base.identity, ...partial.identity, candidates: partial.identity.candidates ?? [] }
      : base.identity,
    metadata: partial.metadata === undefined ? base.metadata : partial.metadata,
    artwork: { ...base.artwork, ...partial.artwork },
    steam: partial.steam ? { ...base.steam, ...partial.steam } : base.steam,
    availableVersions: partial.availableVersions ?? base.availableVersions
  }
}

export function makeIdentity(
  status: IdentityState['status'],
  candidates: IdentityCandidate[],
  partial: Partial<IdentityState> = {}
): IdentityState {
  return { status, candidates, ...partial }
}

export function makeAccount(partial: Partial<SteamAccount> = {}): SteamAccount {
  return {
    accountId: '76561198000000001',
    steamId64: '76561198000000001',
    personaName: 'Marco',
    shortcutsPath: 'C:\\Program Files (x86)\\Steam\\userdata\\76561198000000001\\config\\shortcuts.vdf',
    isActive: false,
    isSelected: true,
    ...partial
  }
}

export function makeSteamSyncResult(partial: Partial<SteamSyncResult> = {}): SteamSyncResult {
  return {
    id: 'sync-1',
    status: 'completed',
    requestedAt: NOW,
    completedAt: NOW,
    appliedGameIds: ['hollow-signal'],
    backupPath: 'C:\\Users\\Player\\AppData\\Roaming\\BPSteamFit\\steam-backups\\sync-1',
    steamRestarted: true,
    ...partial
  }
}

export function makeSteamStatus(partial: Partial<SteamStatus> = {}): SteamStatus {
  return {
    installed: true,
    steamPath: 'C:\\Program Files (x86)\\Steam',
    running: false,
    accounts: [makeAccount()],
    selectedAccountId: '76561198000000001',
    pendingChanges: [],
    ...partial
  }
}

export function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    packageFolders: ['C:\\Users\\Player\\BPSteamFit\\Packages'],
    installationRoot: 'C:\\Games\\BPSteamFit',
    metadataProvider: 'mock',
    referToMetadataInSpanish: true,
    selectedSteamAccountId: '76561198000000001',
    onboardingCompleted: true,
    ...partial
  }
}

export function makeProviders(partial: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    mock: { available: true, description: 'Fichas de ejemplo incluidas con la app.', ...partial.mock },
    steamgriddb: {
      configured: false,
      available: true,
      description: 'Metadatos y arte de SteamGridDB.',
      attribution: 'Datos de SteamGridDB.',
      ...partial.steamgriddb
    }
  }
}

export function makeBootstrap(partial: Partial<BootstrapData> = {}): BootstrapData {
  return {
    appVersion: partial.appVersion ?? '0.1.0',
    platform: partial.platform ?? 'win32',
    settings: partial.settings ? makeSettings(partial.settings) : makeSettings(),
    games: partial.games ?? [makeGame()],
    steam: partial.steam ? makeSteamStatus(partial.steam) : makeSteamStatus(),
    providers: partial.providers ? makeProviders(partial.providers) : makeProviders()
  }
}

export const TEST_NOW = NOW
export const DEFAULT_ARTWORK_KIND: ArtworkKind = 'portrait'
