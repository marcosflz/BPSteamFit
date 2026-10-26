import type {
  AppEventMap,
  ArtworkGalleryItem,
  ArtworkKind,
  BootstrapData,
  CatalogGame,
  SettingsPatch,
  SteamStatus
} from '@shared/domain'
import type { BpsApi } from '@shared/ipc'
import { makeArtwork, makeBootstrap, makeCandidate, makeGalleryItem, makeSnapshot } from './fixtures'

export interface ApiCall {
  method: keyof BpsApi
  args: unknown[]
}

export type FakeAppEvent = {
  type: keyof AppEventMap
  payload: AppEventMap[keyof AppEventMap]
}

export interface FakeApi extends BpsApi {
  data: BootstrapData
  calls: ApiCall[]
  emit: (event: FakeAppEvent) => void
  listenerCount: () => number
}

export interface FakeApiOptions {
  bootstrap?: BootstrapData
  galleries?: Partial<Record<ArtworkKind, ArtworkGalleryItem[]>>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function makeDefaultGallery(game: CatalogGame, kind: ArtworkKind): ArtworkGalleryItem[] {
  const dims =
    kind === 'portrait'
      ? { width: 600, height: 900 }
      : kind === 'hero'
        ? { width: 1920, height: 620 }
        : kind === 'logo'
          ? { width: 800, height: 310 }
          : kind === 'icon'
            ? { width: 512, height: 512 }
            : { width: 1920, height: 1080 }
  const chosenId = game.artwork[kind]?.id
  const providerId = `${kind}-provider`
  const manualId = `${kind}-manual`
  return [
    makeGalleryItem({
      id: providerId,
      kind,
      provider: 'SteamGridDB',
      providerGameId: 'sgdb-1',
      source: 'provider',
      previewUrl: `bps-media://artwork/${providerId}`,
      selected: chosenId === providerId,
      ...dims
    }),
    makeGalleryItem({
      id: manualId,
      kind,
      provider: 'Archivo local',
      source: 'manual',
      previewUrl: `bps-media://artwork/${manualId}`,
      selected: chosenId === manualId,
      ...dims
    })
  ]
}

/**
 * Fake de BpsApi para jsdom. Registra todas las llamadas y permite emitir
 * eventos del proceso principal. No simula plazos ni trabajo real.
 */
export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const data = options.bootstrap ?? makeBootstrap()
  const calls: ApiCall[] = []
  const listeners = new Set<(event: FakeAppEvent) => void>()

  const requireGame = (gameId: string): CatalogGame => {
    const game = data.games.find((entry) => entry.id === gameId)
    if (!game) throw Object.assign(new Error('El juego no existe en el catálogo.'), { code: 'PACKAGE_NOT_FOUND' })
    return game
  }

  const replaceGame = (game: CatalogGame): CatalogGame => {
    data.games = data.games.map((entry) => (entry.id === game.id ? game : entry))
    return clone(game)
  }

  const raw: BpsApi = {
    getBootstrap: async () => clone(data),
    refreshCatalog: async () => clone(data.games),
    rescanPackages: async () => clone(data.games),
    importPackageFile: async () => null,
    addPackageFolder: async () => clone(data.settings),
    chooseInstallationRoot: async () => clone(data.settings),
    updateSettings: async (patch: SettingsPatch) => {
      data.settings = { ...data.settings, ...patch }
      return clone(data.settings)
    },
    chooseInstallFolder: async () => 'C:\\Games\\Custom\\HollowSignal',
    startInstall: async (request) => {
      const game = requireGame(request.gameId)
      const snapshot = makeSnapshot('validating', {
        installDir: request.installDir ?? `C:\\Games\\BPSteamFit\\${game.id}`,
        logPath: `C:\\Users\\Player\\AppData\\Roaming\\BPSteamFit\\logs\\${game.id}.log`,
        startedAt: '2026-10-20T18:31:00.000Z',
        progress: { phase: 'Preparando la instalación', indeterminate: true }
      })
      replaceGame({ ...game, install: snapshot })
      return { snapshot: clone(snapshot) }
    },
    cancelOperation: async (gameId) => {
      const game = requireGame(gameId)
      replaceGame({
        ...game,
        install: {
          ...game.install,
          state: 'cancelled',
          progress: undefined,
          finishedAt: '2026-10-20T18:32:00.000Z',
          updatedAt: '2026-10-20T18:32:00.000Z'
        }
      })
    },
    revalidateInstall: async (gameId) => {
      const game = requireGame(gameId)
      return replaceGame({
        ...game,
        install: {
          ...game.install,
          state: 'installed',
          verification: {
            ok: true,
            checkedAt: '2026-10-20T18:35:00.000Z',
            missingFiles: [],
            missingDirectories: []
          },
          updatedAt: '2026-10-20T18:35:00.000Z'
        }
      })
    },
    launchGame: async () => undefined,
    revealGame: async () => undefined,
    refreshMetadata: async (gameId) => clone(requireGame(gameId)),
    searchIdentity: async (gameId, query) => {
      const game = requireGame(gameId)
      const candidate = makeCandidate({
        key: `mock:${query.toLowerCase().replace(/\s+/g, '-')}`,
        title: query,
        providerId: query.toLowerCase().replace(/\s+/g, '-')
      })
      return replaceGame({
        ...game,
        identity: { status: 'ambiguous', candidates: [candidate] }
      })
    },
    chooseIdentity: async (gameId, candidateKey) => {
      const game = requireGame(gameId)
      const candidate = game.identity.candidates.find((entry) => entry.key === candidateKey)
      if (!candidate) throw new Error('El candidato ya no está disponible.')
      return replaceGame({
        ...game,
        identity: {
          ...game.identity,
          status: 'confirmed',
          provider: candidate.provider,
          providerId: candidate.providerId,
          title: candidate.title,
          releaseYear: candidate.releaseYear,
          decidedBy: 'user',
          updatedAt: '2026-10-20T18:36:00.000Z'
        }
      })
    },
    clearIdentity: async (gameId) => {
      const game = requireGame(gameId)
      return replaceGame({
        ...game,
        identity: { status: 'none', candidates: [] },
        metadata: null
      })
    },
    getArtworkGallery: async (gameId, kind) => {
      const configured = options.galleries?.[kind]
      if (configured) return clone(configured)
      return clone(makeDefaultGallery(requireGame(gameId), kind))
    },
    selectArtwork: async (gameId, kind, artworkId) => {
      const game = requireGame(gameId)
      const gallery = options.galleries?.[kind] ?? makeDefaultGallery(game, kind)
      const selected = gallery.find((entry) => entry.id === artworkId)
      const artwork = selected
        ? { ...selected, chosen: true }
        : makeArtwork({ id: artworkId, kind, chosen: true })
      data.games = data.games.map((entry) =>
        entry.id === gameId ? { ...entry, artwork: { ...entry.artwork, [kind]: artwork } } : entry
      )
      return clone(requireGame(gameId))
    },
    importLocalArtwork: async () => null,
    resetArtwork: async (gameId, kind) => {
      const game = requireGame(gameId)
      const nextArtwork = { ...game.artwork }
      delete nextArtwork[kind]
      return replaceGame({ ...game, artwork: nextArtwork })
    },
    getProviderStatus: async () => clone(data.providers),
    setSteamGridDbKey: async () => {
      data.providers = {
        ...data.providers,
        steamgriddb: { ...data.providers.steamgriddb, configured: true, available: true }
      }
      return clone(data.providers)
    },
    clearSteamGridDbKey: async () => {
      data.providers = {
        ...data.providers,
        steamgriddb: { ...data.providers.steamgriddb, configured: false }
      }
      return clone(data.providers)
    },
    refreshSteamAccounts: async () => clone(data.steam.accounts),
    selectSteamAccount: async (accountId) => {
      data.steam = {
        ...data.steam,
        selectedAccountId: accountId,
        accounts: data.steam.accounts.map((account) => ({
          ...account,
          isSelected: account.accountId === accountId
        }))
      }
      return clone(data.steam)
    },
    prepareSteamSync: async () => clone(data.steam),
    startSteamSync: async (confirmed) => {
      if (!confirmed) throw new Error('La sincronización requiere confirmación.')
      const pending = data.steam.pendingChanges.map((change) => change.gameId)
      data.steam = {
        ...data.steam,
        pendingChanges: [],
        lastResult: {
          id: 'sync-ui-test',
          status: 'completed',
          requestedAt: '2026-10-20T18:40:00.000Z',
          completedAt: '2026-10-20T18:40:30.000Z',
          appliedGameIds: pending,
          backupPath: 'C:\\Users\\Player\\AppData\\Roaming\\BPSteamFit\\steam-backups\\sync-ui-test',
          steamRestarted: true
        }
      }
      return {
        scheduled: true,
        message: 'Sincronización programada. Steam se reiniciará si es necesario.'
      }
    },
    getSteamStatus: async () => clone(data.steam as SteamStatus),
    openLogFolder: async () => undefined,
    openPath: async () => undefined,
    quit: async () => undefined,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  const proxy = new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (
        typeof value !== 'function' ||
        property === 'onEvent' ||
        property === 'emit' ||
        property === 'listenerCount'
      ) {
        return value
      }
      return (...args: unknown[]) => {
        calls.push({ method: property as keyof BpsApi, args })
        return (value as (...inner: unknown[]) => unknown).apply(target, args)
      }
    }
  })

  const fake = Object.assign(proxy, {
    data,
    calls,
    emit: (event: FakeAppEvent) => {
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size
  }) as FakeApi

  return fake
}

export function callsFor(api: FakeApi, method: keyof BpsApi): ApiCall[] {
  return api.calls.filter((call) => call.method === method)
}

export function lastCall(api: FakeApi, method: keyof BpsApi): ApiCall | undefined {
  const matches = callsFor(api, method)
  return matches[matches.length - 1]
}
