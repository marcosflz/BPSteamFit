import { app, BrowserWindow, dialog, Menu } from 'electron'
import path from 'node:path'
import { AppDatabase } from '@core/storage/database'
import { cleanupStaleInstallTemps, createAppPaths, createSessionLogPath, ensureBaseDirectories } from '@core/config/app-paths'
import { FileLog } from '@core/logging/install-log'
import { SettingsRepository } from '@core/storage/settings-repository'
import { SettingsService } from '@core/settings/settings-service'
import { CatalogService } from '@core/catalog/catalog-service'
import { InstallService } from '@core/install/install-service'
import { ArtworkRepository } from '@core/storage/artwork-repository'
import { FileArtworkStorage } from '@core/storage/artwork-storage'
import { SqliteMetadataCache } from '@core/storage/metadata-cache-repository'
import { EnrichmentService } from '@core/catalog/enrichment-service'
import { SteamRepository } from '@core/storage/steam-repository'
import { SecretStore, SECRET_STEAMGRIDDB } from './secrets'
import { SteamService } from './steam-service'
import { registerIpc, type IpcRuntime } from './ipc'
import { createMainWindow, setPermissionPolicy } from './window'
import { registerMediaProtocol, registerMediaScheme } from './media'
import { IPC } from '@shared/ipc'

app.setName('BPSteamFit')
const userDataOverride = process.env.BPSFIT_USER_DATA
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride))
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'BPSteamFit'))
}
app.setAppUserModelId('com.bpsteamfit.app')
registerMediaScheme()

const hasLock = app.requestSingleInstanceLock()
let mainWindow: BrowserWindow | null = null
let allowQuit = false

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(start).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    dialog.showErrorBox('BPSteamFit no pudo iniciar', message)
    app.quit()
  })
}

async function start(): Promise<void> {
  setPermissionPolicy()
  Menu.setApplicationMenu(null)

  const paths = createAppPaths(app.getPath('userData'))
  await ensureBaseDirectories(paths)
  const log = await FileLog.create(createSessionLogPath(paths, 'app'))
  const cleanedTemps = await cleanupStaleInstallTemps(paths)
  if (cleanedTemps > 0) log.info(`Temporales de instalación antiguos eliminados: ${cleanedTemps}.`)
  const database = AppDatabase.open(paths.databaseFile)
  const settingsHome = process.env.BPSFIT_HOME_DIR
    ? path.resolve(process.env.BPSFIT_HOME_DIR)
    : app.getPath('home')
  const settingsRepo = new SettingsRepository(database, settingsHome)
  const settingsService = new SettingsService(settingsRepo)
  await settingsService.update({})
  const secureStore = new SecretStore(settingsRepo)

  const broadcast = (type: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.event, { type, payload })
    }
  }

  let enrichment: EnrichmentService | null = null
  const catalog = new CatalogService({
    database,
    paths,
    settings: settingsRepo,
    log,
    onChanged: (reason, gameId) => broadcast('catalog:changed', { reason, gameId }),
    onGameImported: (gameId) => {
      enrichment?.enqueueAuto(gameId)
    }
  })

  const artwork = new ArtworkRepository(database)
  const artworkStorage = new FileArtworkStorage(paths.artwork)
  const cache = new SqliteMetadataCache(database)
  enrichment = new EnrichmentService({
    catalog: catalog.repository,
    artwork,
    artworkStorage,
    cache,
    settings: settingsRepo,
    log,
    getSteamGridDbKey: () => {
      try {
        return secureStore.get(SECRET_STEAMGRIDDB)
      } catch {
        return null
      }
    },
    onChanged: (reason, gameId) => broadcast('catalog:changed', { reason, gameId })
  })

  const elevationHelperPath = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'bpsfit-elevate.exe')
    : path.join(app.getAppPath(), 'resources', 'native', 'bpsfit-elevate.exe')
  const install = new InstallService({
    database,
    paths,
    settings: settingsRepo,
    catalog,
    log,
    appRoot: app.getAppPath(),
    elevationHelperPath,
    onInstallProgress: (gameId, snapshot) =>
      broadcast('install:progress', { gameId, snapshot }),
    onCatalogChanged: (reason, gameId) => broadcast('catalog:changed', { reason, gameId })
  })
  install.markInterruptedOnStartup()

  const steamRepository = new SteamRepository(database)
  const steam = new SteamService({
    catalog: catalog.repository,
    artwork,
    artworkStorage,
    settings: settingsRepo,
    steam: steamRepository,
    paths,
    log,
    onChanged: (status) => broadcast('steam:changed', status)
  })

  const restartWatchers = (): void => {
    catalog.stopWatching()
    catalog.startWatching()
  }
  const quitAfterSteamSync = (): void => {
    allowQuit = true
    app.quit()
  }
  const requestQuit = (): void => {
    app.quit()
  }

  const runtime: IpcRuntime = {
    mainWindow: () => mainWindow,
    appVersion: app.getVersion(),
    paths,
    log,
    settingsService,
    secureStore,
    catalog,
    install,
    enrichment,
    steam,
    steamRepository,
    restartWatchers,
    requestQuit,
    quitAfterSteamSync,
    broadcast
  }
  registerIpc(runtime)

  registerMediaProtocol(async (url) => {
    if (url.hostname !== 'asset') return null
    const rawId = url.pathname.replace(/^\/+/, '')
    if (!rawId || rawId.length > 700) return null
    let assetId: string
    try {
      assetId = decodeURIComponent(rawId)
    } catch {
      return null
    }
    const variant = url.searchParams.get('variant') === 'original' ? 'original' : 'preview'
    const key = enrichment?.getMediaStorageKey(assetId, variant)
    if (!key) return null
    const filePath = await artworkStorage.resolveFile(key)
    return filePath ? { filePath } : null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const windowed =
    process.env.BPSFIT_WINDOWED === '1' ||
    (Boolean(devUrl) && process.env.BPSFIT_FULLSCREEN !== '1')
  mainWindow = createMainWindow({
    preloadPath: path.join(__dirname, '../preload/index.js'),
    ...(devUrl ? { devUrl } : {}),
    windowed
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('close', (event) => {
    if (allowQuit || !install.isBusy()) return
    event.preventDefault()
    const response = mainWindow
      ? dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          title: 'Instalación en curso',
          message: 'Hay un instalador en ejecución.',
          detail:
            'Si cierras BPSteamFit, el setup puede continuar en segundo plano y la app no podrá verificar el resultado. El estado quedará como interrumpido al volver a abrir. No se fuerza la terminación del instalador.',
          buttons: ['Seguir en la app', 'Cerrar de todos modos'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
      : 0
    if (response === 1) {
      allowQuit = true
      mainWindow?.destroy()
    }
  })

  app.on('before-quit', (event) => {
    if (allowQuit || !install.isBusy()) return
    event.preventDefault()
    const response = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Instalación en curso',
      message: 'Hay un instalador en ejecución.',
      detail:
        'Si cierras BPSteamFit, el setup puede continuar en segundo plano y la app no podrá verificar el resultado. El estado quedará como interrumpido al volver a abrir. No se fuerza la terminación del instalador.',
      buttons: ['Seguir en la app', 'Cerrar de todos modos'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response === 1) {
      allowQuit = true
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  let cleaned = false
  app.on('will-quit', () => {
    if (cleaned) return
    cleaned = true
    catalog.stopWatching()
    try {
      database.close()
    } catch {
      // El cierre de la app no debe fallar por SQLite.
    }
    void log.close()
  })

  process.on('uncaughtException', (error) => {
    log.error(`uncaughtException: ${error.stack ?? error.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
  })

  // La UI se muestra de inmediato con el catálogo persistido; el escaneo y los
  // resultados del auxiliar de Steam se procesan en segundo plano.
  catalog.startWatching()
  void steam.processPendingResults().catch((error: unknown) => {
    log.warn(`No se pudieron procesar resultados de Steam: ${String(error)}`)
  })
  const runStartupScan = (): void => {
    void catalog
      .scan()
      .then((summary) => {
        if (summary.issues.length > 0) {
          broadcast('toast', {
            type: 'error',
            message: `Escaneo: ${summary.issues[0]?.message ?? 'error'}`
          })
        }
        log.info(
          `Escaneo de arranque: ${summary.imported} importados, ${summary.duplicates} duplicados, ${summary.unavailable} no disponibles.`
        )
      })
      .catch((error: unknown) => {
        log.error(`Escaneo de arranque falló: ${String(error)}`)
        broadcast('toast', { type: 'error', message: 'No se pudo escanear la carpeta de paquetes.' })
      })
  }
  if (mainWindow) {
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(runStartupScan, 350)
      })
    } else {
      setTimeout(runStartupScan, 350)
    }
  } else {
    runStartupScan()
  }
}
