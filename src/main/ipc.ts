import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppSettings,
  ArtworkKind,
  BootstrapData,
  CatalogGame,
  ProviderStatus,
  SteamAccount,
  SteamStatus,
  SteamSyncResult
} from '@shared/domain'
import { ARTWORK_KINDS } from '@shared/domain'
import { AppError, isAppError, serializeError } from '@shared/errors'
import { IPC, type StartInstallResult, type SteamSyncStartResult } from '@shared/ipc'
import { isPathInside } from '@shared/safe-path'
import type { AppPaths } from '@core/config/app-paths'
import type { SecretStore } from './secrets'
import { SECRET_STEAMGRIDDB } from './secrets'
import type { SettingsService } from '@core/settings/settings-service'
import type { CatalogService } from '@core/catalog/catalog-service'
import type { InstallService } from '@core/install/install-service'
import type { EnrichmentService } from '@core/catalog/enrichment-service'
import type { SteamService } from './steam-service'
import type { FileLog } from '@core/logging/install-log'
import type { SteamRepository } from '@core/storage/steam-repository'

export interface IpcRuntime {
  mainWindow: () => BrowserWindow | null
  appVersion: string
  paths: AppPaths
  log: FileLog
  settingsService: SettingsService
  secureStore: SecretStore
  catalog: CatalogService
  install: InstallService
  enrichment: EnrichmentService
  steam: SteamService
  steamRepository: SteamRepository
  restartWatchers: () => void
  requestQuit: () => void
  quitAfterSteamSync: () => void
  broadcast: (type: string, payload: unknown) => void
}

function assertString(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new AppError('VALIDATION_ERROR', `${label} no es válido.`)
  }
  return value
}

function assertArtworkKind(value: unknown): ArtworkKind {
  if (typeof value !== 'string' || !(ARTWORK_KINDS as readonly string[]).includes(value)) {
    throw new AppError('VALIDATION_ERROR', 'Tipo de artwork no válido.')
  }
  return value as ArtworkKind
}

async function chooseDirectory(
  window: BrowserWindow | null,
  title: string,
  defaultPath?: string
): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
}

function providerStatus(runtime: IpcRuntime): ProviderStatus {
  const status = runtime.enrichment.getProviderStatus()
  const hasKey = runtime.secureStore.has(SECRET_STEAMGRIDDB)
  const active = runtime.settingsService.get().metadataProvider
  status.steamgriddb.configured = hasKey
  status.steamgriddb.available = hasKey && active === 'steamgriddb'
  return status
}

function catalogOrThrow(runtime: IpcRuntime, gameId: string): CatalogGame {
  const game = runtime.catalog.getGame(gameId)
  if (!game) throw new AppError('PACKAGE_NOT_FOUND', 'El juego no existe en el catálogo.')
  return game
}

function registerHandler<TArgs extends unknown[], TResult>(
  runtime: IpcRuntime,
  channel: string,
  handler: (...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const window = runtime.mainWindow()
    if (!window || event.sender !== window.webContents) {
      return {
        ok: false,
        error: serializeError(
          new AppError('VALIDATION_ERROR', 'Origen IPC no autorizado.')
        )
      }
    }
    try {
      const data = await handler(...(args as TArgs))
      return { ok: true, data }
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new AppError('UNKNOWN', 'La operación falló.', {
            cause: error instanceof Error ? error.message : String(error)
          })
      runtime.log.write(
        appError.code === 'VALIDATION_ERROR' ? 'warn' : 'error',
        `IPC ${channel}: [${appError.code}] ${appError.message}`
      )
      return { ok: false, error: serializeError(appError) }
    }
  })
}

function knownInstallDirectories(runtime: IpcRuntime): string[] {
  return runtime.catalog.repository
    .listAggregates()
    .map((aggregate) => aggregate.install?.install_dir ?? null)
    .filter((value): value is string => Boolean(value))
}

function knownPackageFiles(runtime: IpcRuntime): string[] {
  return runtime.catalog.repository.listAllPackageRows().map((row) => row.file_path)
}

export function registerIpc(runtime: IpcRuntime): void {
  registerHandler(runtime, IPC.bootstrap, async (): Promise<BootstrapData> => {
    await runtime.steam.processPendingResults()
    const settings = runtime.settingsService.get()
    const games = runtime.catalog.getGames()
    const steam = await runtime.steam.getStatus()
    return {
      appVersion: runtime.appVersion,
      platform: process.platform,
      settings,
      games,
      steam,
      providers: providerStatus(runtime)
    }
  })

  registerHandler(runtime, IPC.refreshCatalog, async (): Promise<CatalogGame[]> => {
    return runtime.catalog.getGames()
  })

  registerHandler(runtime, IPC.rescanPackages, async (): Promise<CatalogGame[]> => {
    await runtime.catalog.scan()
    return runtime.catalog.getGames()
  })

  registerHandler(runtime, IPC.importPackageFile, async (): Promise<CatalogGame | null> => {
    const window = runtime.mainWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Importar paquete .game',
          filters: [{ name: 'Paquete BPSteamFit', extensions: ['game'] }],
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: 'Importar paquete .game',
          filters: [{ name: 'Paquete BPSteamFit', extensions: ['game'] }],
          properties: ['openFile']
        })
    if (result.canceled || !result.filePaths[0]) return null
    const summary = await runtime.catalog.importExternalFile(result.filePaths[0])
    const gameId = summary.importedGameIds[0]
    return gameId ? runtime.catalog.getGame(gameId) : null
  })

  registerHandler(runtime, IPC.addPackageFolder, async (): Promise<AppSettings | null> => {
    const selected = await chooseDirectory(runtime.mainWindow(), 'Añadir carpeta de paquetes .game')
    if (!selected) return null
    const settings = await runtime.settingsService.addPackageFolder(selected)
    runtime.restartWatchers()
    void runtime.catalog.scan().catch((error: unknown) => {
      runtime.log.warn(`Escaneo tras añadir carpeta: ${String(error)}`)
    })
    return settings
  })

  registerHandler(runtime, IPC.chooseInstallationRoot, async (): Promise<AppSettings | null> => {
    const settings = runtime.settingsService.get()
    const selected = await chooseDirectory(
      runtime.mainWindow(),
      'Elegir carpeta para juegos instalados',
      settings.installationRoot
    )
    if (!selected) return null
    return runtime.settingsService.chooseInstallationRoot(selected)
  })

  registerHandler(runtime, IPC.updateSettings, async (patch: unknown): Promise<AppSettings> => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError('SETTINGS_INVALID', 'Los ajustes enviados no son válidos.')
    }
    const requested = patch as { metadataProvider?: unknown }
    if (
      requested.metadataProvider === 'steamgriddb' &&
      !runtime.secureStore.has(SECRET_STEAMGRIDDB)
    ) {
      throw new AppError(
        'METADATA_AUTH_REQUIRED',
        'Configura una clave de SteamGridDB antes de activar ese proveedor. El catálogo local sigue disponible.'
      )
    }
    const before = runtime.settingsService.get()
    const settings = await runtime.settingsService.update(patch)
    const foldersChanged =
      JSON.stringify(before.packageFolders) !== JSON.stringify(settings.packageFolders)
    const providerChanged =
      before.metadataProvider !== settings.metadataProvider ||
      before.referToMetadataInSpanish !== settings.referToMetadataInSpanish
    if (foldersChanged) {
      runtime.restartWatchers()
      void runtime.catalog.scan().catch(() => undefined)
    }
    if (providerChanged) {
      runtime.enrichment.invalidateProvider()
      for (const game of runtime.catalog.getGames()) runtime.enrichment.enqueueAuto(game.id)
    }
    runtime.broadcast('catalog:changed', { reason: 'settings' })
    return settings
  })

  registerHandler(runtime, IPC.chooseInstallFolder, async (gameId: unknown): Promise<string | null> => {
    const id = assertString(gameId, 'gameId', 200)
    const game = catalogOrThrow(runtime, id)
    const settings = runtime.settingsService.get()
    return chooseDirectory(
      runtime.mainWindow(),
      `Carpeta de instalación para ${game.name}`,
      path.join(settings.installationRoot, id)
    )
  })

  registerHandler(runtime, IPC.startInstall, async (request: unknown): Promise<StartInstallResult> => {
    if (!request || typeof request !== 'object') {
      throw new AppError('VALIDATION_ERROR', 'La solicitud de instalación no es válida.')
    }
    const value = request as { gameId?: unknown; installDir?: unknown }
    const gameId = assertString(value.gameId, 'gameId', 200)
    const installDir =
      value.installDir === undefined ? undefined : assertString(value.installDir, 'installDir', 1024)
    return runtime.install.startInstall({ gameId, ...(installDir ? { installDir } : {}) })
  })

  registerHandler(runtime, IPC.cancelOperation, async (gameId: unknown): Promise<void> => {
    await runtime.install.cancel(assertString(gameId, 'gameId', 200))
  })

  registerHandler(runtime, IPC.revalidateInstall, async (gameId: unknown): Promise<CatalogGame> => {
    return runtime.install.revalidate(assertString(gameId, 'gameId', 200))
  })

  registerHandler(runtime, IPC.launchGame, async (gameId: unknown): Promise<void> => {
    const id = assertString(gameId, 'gameId', 200)
    await runtime.install.launch(id)
    runtime.mainWindow()?.minimize()
  })

  registerHandler(runtime, IPC.revealGame, async (gameId: unknown): Promise<void> => {
    const id = assertString(gameId, 'gameId', 200)
    const game = catalogOrThrow(runtime, id)
    const installDir = game.install.installDir
    if (game.install.state === 'installed' && installDir) {
      await shell.openPath(installDir)
      return
    }
    if (game.packagePath) shell.showItemInFolder(game.packagePath)
  })

  registerHandler(runtime, IPC.refreshMetadata, async (gameId: unknown): Promise<CatalogGame> => {
    const game = await runtime.enrichment.refreshManual(assertString(gameId, 'gameId', 200))
    runtime.broadcast('catalog:changed', { reason: 'metadata', gameId: game.id })
    return game
  })

  registerHandler(runtime, IPC.searchIdentity, async (gameId: unknown, query: unknown): Promise<CatalogGame> => {
    const id = assertString(gameId, 'gameId', 200)
    const text = assertString(query, 'búsqueda', 200)
    const game = await runtime.enrichment.searchIdentity(id, text)
    runtime.broadcast('catalog:changed', { reason: 'identity', gameId: id })
    return game
  })

  registerHandler(runtime, IPC.chooseIdentity, async (gameId: unknown, key: unknown): Promise<CatalogGame> => {
    const id = assertString(gameId, 'gameId', 200)
    const candidateKey = assertString(key, 'candidato', 300)
    const game = await runtime.enrichment.chooseIdentity(id, candidateKey)
    runtime.broadcast('catalog:changed', { reason: 'identity', gameId: id })
    return game
  })

  registerHandler(runtime, IPC.clearIdentity, async (gameId: unknown): Promise<CatalogGame> => {
    const id = assertString(gameId, 'gameId', 200)
    const game = await runtime.enrichment.clearIdentity(id)
    runtime.broadcast('catalog:changed', { reason: 'identity', gameId: id })
    return game
  })

  registerHandler(runtime, IPC.artworkGallery, async (gameId: unknown, kind: unknown) => {
    return runtime.enrichment.artworkGallery(
      assertString(gameId, 'gameId', 200),
      assertArtworkKind(kind)
    )
  })

  registerHandler(runtime, IPC.selectArtwork, async (gameId: unknown, kind: unknown, artworkId: unknown): Promise<CatalogGame> => {
    const id = assertString(gameId, 'gameId', 200)
    return runtime.enrichment.selectArtwork(
      id,
      assertArtworkKind(kind),
      assertString(artworkId, 'artwork', 500)
    )
  })

  registerHandler(runtime, IPC.importLocalArtwork, async (gameId: unknown, kind: unknown): Promise<CatalogGame | null> => {
    const id = assertString(gameId, 'gameId', 200)
    const artworkKind = assertArtworkKind(kind)
    const window = runtime.mainWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Elegir imagen local',
          filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: 'Elegir imagen local',
          filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
          properties: ['openFile']
        })
    if (result.canceled || !result.filePaths[0]) return null
    const game = await runtime.enrichment.importLocalArtwork(id, artworkKind, result.filePaths[0])
    runtime.broadcast('catalog:changed', { reason: 'artwork', gameId: id })
    return game
  })

  registerHandler(runtime, IPC.resetArtwork, async (gameId: unknown, kind: unknown): Promise<CatalogGame> => {
    const id = assertString(gameId, 'gameId', 200)
    const game = await runtime.enrichment.resetArtwork(id, assertArtworkKind(kind))
    runtime.broadcast('catalog:changed', { reason: 'artwork', gameId: id })
    return game
  })

  registerHandler(runtime, IPC.providerStatus, async (): Promise<ProviderStatus> => {
    return providerStatus(runtime)
  })

  registerHandler(runtime, IPC.setSteamGridDbKey, async (key: unknown): Promise<ProviderStatus> => {
    const value = assertString(key, 'clave', 512)
    runtime.secureStore.set(SECRET_STEAMGRIDDB, value)
    runtime.enrichment.invalidateProvider()
    for (const game of runtime.catalog.getGames()) {
      if (!game.metadata) runtime.enrichment.enqueueAuto(game.id)
    }
    return providerStatus(runtime)
  })

  registerHandler(runtime, IPC.clearSteamGridDbKey, async (): Promise<ProviderStatus> => {
    runtime.secureStore.delete(SECRET_STEAMGRIDDB)
    runtime.enrichment.invalidateProvider()
    return providerStatus(runtime)
  })

  registerHandler(runtime, IPC.refreshAccounts, async (): Promise<SteamAccount[]> => {
    return runtime.steam.refreshAccounts()
  })

  registerHandler(runtime, IPC.selectSteamAccount, async (accountId: unknown) => {
    return runtime.steam.selectAccount(assertString(accountId, 'cuenta', 32))
  })

  registerHandler(runtime, IPC.prepareSteamSync, async (): Promise<SteamStatus> => {
    return runtime.steam.prepareSync()
  })

  registerHandler(runtime, IPC.startSteamSync, async (confirmed: unknown): Promise<SteamSyncStartResult> => {
    if (typeof confirmed !== 'boolean' || !confirmed) {
      throw new AppError('VALIDATION_ERROR', 'La sincronización requiere confirmación explícita.')
    }
    if (runtime.install.isBusy()) {
      throw new AppError('INSTALL_BUSY', 'Espera a que termine la instalación antes de sincronizar Steam.')
    }
    const result = await runtime.steam.startSync(confirmed)
    if (result.scheduled) {
      setTimeout(() => runtime.quitAfterSteamSync(), 900)
    }
    return result
  })

  registerHandler(runtime, IPC.getSteamStatus, async (): Promise<SteamStatus> => {
    return runtime.steam.getStatus()
  })

  registerHandler(runtime, IPC.openLogFolder, async (): Promise<void> => {
    const error = await shell.openPath(runtime.paths.logs)
    if (error) throw new AppError('IO_ERROR', 'No se pudo abrir la carpeta de logs.', { cause: error })
  })

  registerHandler(runtime, IPC.openPath, async (target: unknown, purpose: unknown): Promise<void> => {
    const filePath = assertString(target, 'ruta', 2048)
    const kind = assertString(purpose, 'propósito', 32)
    const resolved = path.resolve(filePath)
    if (kind === 'log') {
      if (!isPathInside(runtime.paths.logs, resolved)) {
        throw new AppError('VALIDATION_ERROR', 'La ruta de log no pertenece a la app.')
      }
      shell.showItemInFolder(resolved)
      return
    }
    if (kind === 'install-dir') {
      const allowed = knownInstallDirectories(runtime).some((directory) =>
        isPathInside(directory, resolved)
      )
      if (!allowed) {
        throw new AppError('VALIDATION_ERROR', 'La ruta de instalación no está registrada.')
      }
      const info = await lstat(resolved).catch(() => null)
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Solo se puede abrir la carpeta de instalación, no un archivo.'
        )
      }
      const error = await shell.openPath(resolved)
      if (error) throw new AppError('IO_ERROR', 'No se pudo abrir la carpeta.', { cause: error })
      return
    }
    if (kind === 'package') {
      const allowed = knownPackageFiles(runtime).some(
        (packagePath) => path.resolve(packagePath).toLowerCase() === resolved.toLowerCase()
      )
      if (!allowed) {
        throw new AppError('VALIDATION_ERROR', 'El paquete no está registrado en el catálogo.')
      }
      shell.showItemInFolder(resolved)
      return
    }
    throw new AppError('VALIDATION_ERROR', 'Propósito de apertura no válido.')
  })

  registerHandler(runtime, IPC.quit, async (): Promise<void> => {
    runtime.requestQuit()
  })
}
