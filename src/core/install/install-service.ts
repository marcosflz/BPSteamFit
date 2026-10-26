import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { CatalogGame, InstallSnapshot, SteamGameState } from '@shared/domain'
import { AppError, serializeError } from '@shared/errors'
import { slugifyGameId } from '@shared/safe-path'
import { createInstallLogPath, type AppPaths } from '../config/app-paths'
import { runInstallation, assertInstallDestination, buildLaunchCommand, revalidateInstalledGame, isInstallTerminal } from '../install/engine'
import type { FileLog } from '../logging/install-log'
import type { CatalogService } from '../catalog/catalog-service'
import type { AppDatabase } from '../storage/database'
import { InstallRepository } from '../storage/install-repository'
import type { SettingsRepository } from '../storage/settings-repository'
import { parseGame, parsePackage } from '../storage/parsers'

export interface InstallServiceOptions {
  database: AppDatabase
  paths: AppPaths
  settings: SettingsRepository
  catalog: CatalogService
  log: FileLog
  appRoot?: string
  elevationHelperPath?: string
  onInstallProgress?: (gameId: string, snapshot: InstallSnapshot) => void
  onCatalogChanged?: (reason: string, gameId?: string) => void
}

export interface StartInstallOptions {
  gameId: string
  installDir?: string
}

export interface StartInstallOutcome {
  snapshot: InstallSnapshot
}

export class InstallService {
  readonly repository: InstallRepository
  private activeGameId: string | null = null
  private startingGameId: string | null = null
  private activeController: AbortController | null = null
  private currentSnapshots = new Map<string, InstallSnapshot>()

  constructor(private readonly options: InstallServiceOptions) {
    this.repository = new InstallRepository(options.database)
  }

  markInterruptedOnStartup(): number {
    const interrupted = this.repository.markInterruptedOnStartup()
    for (const entry of interrupted) {
      this.options.log.warn(
        `Instalación interrumpida detectada al arrancar: ${entry.gameId}${entry.pid ? ` (PID ${entry.pid})` : ''}`
      )
      const snapshot = this.repository.getSnapshot(entry.gameId)
      if (snapshot) this.options.onInstallProgress?.(entry.gameId, snapshot)
    }
    if (interrupted.length > 0) this.options.onCatalogChanged?.('startup-recovery')
    return interrupted.length
  }

  getSnapshot(gameId: string): InstallSnapshot | null {
    return this.currentSnapshots.get(gameId) ?? this.repository.getSnapshot(gameId)
  }

  private testPidAlive(pid?: number): boolean {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async startInstall(input: StartInstallOptions): Promise<StartInstallOutcome> {
    if (this.activeGameId || this.startingGameId) {
      throw new AppError(
        'INSTALL_BUSY',
        'Ya hay una instalación en curso. Espera a que termine antes de iniciar otra.'
      )
    }
    if (this.repository.getActiveCount() > 0) {
      throw new AppError(
        'INSTALL_BUSY',
        'La base de datos indica una instalación activa. Reinicia la app o comprueba su estado.'
      )
    }
    const game = this.options.catalog.getGame(input.gameId)
    if (!game) throw new AppError('PACKAGE_NOT_FOUND', 'El juego no está en el catálogo.')
    if (!game.packageAvailable) {
      throw new AppError(
        'PACKAGE_UNAVAILABLE',
        game.packageProblem ?? 'El paquete del juego no está disponible en su carpeta.'
      )
    }
    if (game.install.state === 'installed' || game.install.state === 'reboot_pending') {
      throw new AppError(
        'INSTALL_INVALID_STATE',
        'El juego ya figura como instalado. Usa "Comprobar instalación" o la sincronización con Steam.'
      )
    }
    if (game.requiresElevation) {
      this.options.log.info(
        `El paquete ${game.id} declara elevación. Se usará el auxiliar de UAC; el escritorio seguro requiere intervención manual.`
      )
    }
    const aggregate = this.options.catalog.repository.getAggregate(game.id)
    if (!aggregate?.currentPackage) {
      throw new AppError('PACKAGE_UNAVAILABLE', 'No hay un paquete actual válido para instalar.')
    }

    // El bloqueo se toma antes del primer await para que dos invocaciones
    // concurrentes no puedan iniciar dos setups.
    this.startingGameId = game.id
    try {
      const settings = this.options.settings.get()
      await mkdir(settings.installationRoot, { recursive: true })
      const defaultInstallDir = path.join(settings.installationRoot, slugifyGameId(game.id))
      const installDir = input.installDir
        ? path.resolve(input.installDir)
        : path.resolve(defaultInstallDir)

      const protectedPaths = [
        this.options.paths.userData,
        this.options.paths.logs,
        this.options.paths.temp,
        this.options.paths.artwork,
        this.options.paths.steamBackups,
        this.options.paths.steamSync,
        ...(this.options.appRoot ? [this.options.appRoot] : [])
      ]
      await assertInstallDestination(installDir, this.options.paths.temp, protectedPaths)

      const logPath = createInstallLogPath(this.options.paths, game.id)
      const initial: InstallSnapshot = {
        state: 'validating',
        installDir,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        logPath,
        progress: { phase: 'Preparando la instalación', indeterminate: true }
      }
      this.repository.saveSnapshot(game.id, aggregate.currentPackage.key, initial)
      this.currentSnapshots.set(game.id, initial)
      this.options.onInstallProgress?.(game.id, initial)
      this.activeGameId = game.id
      this.startingGameId = null
      this.activeController = new AbortController()
      this.options.onCatalogChanged?.('install-started', game.id)

      void this.execute(
        game,
        aggregate.currentPackage.key,
        aggregate.currentPackage.file_path,
        aggregate.currentPackage.sha256,
        installDir,
        logPath
      )
      return { snapshot: initial }
    } catch (error) {
      this.startingGameId = null
      throw error
    }
  }

  private async execute(
    game: CatalogGame,
    packageKey: string,
    packagePath: string,
    expectedSha256: string,
    installDir: string,
    logPath: string
  ): Promise<void> {
    let lastUiAt = 0
    let lastSavedAt = 0
    let lastSavedState = ''
    try {
      const result = await runInstallation({
        packagePath,
        expectedSha256,
        installDir,
        tempRoot: this.options.paths.temp,
        logPath,
        confirmed: true,
        elevationHelperPath: this.options.elevationHelperPath,
        protectedPaths: [this.options.paths.userData],
        signal: this.activeController?.signal,
        onSnapshot: (snapshot) => {
          this.currentSnapshots.set(game.id, snapshot)
          const now = Date.now()
          const stateChanged = snapshot.state !== lastSavedState
          const terminal = isInstallTerminal(snapshot.state)
          if (stateChanged || terminal || now - lastSavedAt >= 1000) {
            this.repository.saveSnapshot(game.id, packageKey, snapshot)
            lastSavedAt = now
            lastSavedState = snapshot.state
          }
          if (stateChanged || terminal || now - lastUiAt >= 120) {
            this.options.onInstallProgress?.(game.id, snapshot)
            lastUiAt = now
          }
        }
      })

      const finalSnapshot = result.snapshot
      this.currentSnapshots.set(game.id, finalSnapshot)
      this.repository.saveSnapshot(game.id, packageKey, finalSnapshot)
      this.options.onInstallProgress?.(game.id, finalSnapshot)

      if (finalSnapshot.state === 'installed' || finalSnapshot.state === 'reboot_pending') {
        const aggregate = this.options.catalog.repository.getAggregate(game.id)
        if (aggregate) {
          const parsedGame = parseGame(aggregate.game)
          if (parsedGame.steam.enabled && finalSnapshot.state === 'installed') {
            const nextSteam: SteamGameState = {
              ...parsedGame.steam,
              syncState: 'pending'
            }
            this.options.catalog.repository.setSteamGameState(game.id, nextSteam)
          }
        }
      }
      this.options.log.info(
        `Instalación ${game.id} finalizada con estado ${finalSnapshot.state}${finalSnapshot.error ? ` (${finalSnapshot.error.code})` : ''}.`
      )
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError('UNKNOWN', 'La instalación falló de forma inesperada.', { cause: String(error) })
      const failed: InstallSnapshot = {
        ...(this.currentSnapshots.get(game.id) ?? { state: 'failed' }),
        state: 'failed',
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: serializeError(appError)
      }
      this.currentSnapshots.set(game.id, failed)
      this.repository.saveSnapshot(game.id, packageKey, failed)
      this.options.onInstallProgress?.(game.id, failed)
      this.options.log.error(`Error inesperado instalando ${game.id}: ${appError.message}`)
    } finally {
      this.activeGameId = null
      this.activeController = null
      this.options.onCatalogChanged?.('install-finished', game.id)
    }
  }

  async cancel(gameId: string): Promise<void> {
    if (this.activeGameId !== gameId || !this.activeController) {
      throw new AppError('INSTALL_INVALID_STATE', 'No hay una operación cancelable para este juego.')
    }
    const snapshot = this.currentSnapshots.get(gameId)
    if (!snapshot || !['validating', 'extracting'].includes(snapshot.state)) {
      throw new AppError(
        'INSTALL_INVALID_STATE',
        'Solo se puede cancelar durante la validación o la extracción. Una vez iniciado el setup, no se terminará el proceso por la fuerza.'
      )
    }
    this.options.log.info(`Cancelación solicitada para ${gameId}.`)
    this.activeController.abort()
  }

  async revalidate(gameId: string): Promise<CatalogGame> {
    const activeSnapshot = this.activeGameId
      ? this.currentSnapshots.get(this.activeGameId)
      : null
    const operationStillRunning =
      this.startingGameId !== null ||
      (this.activeGameId !== null &&
        (!activeSnapshot || !isInstallTerminal(activeSnapshot.state)))
    if (operationStillRunning || this.repository.getActiveCount() > 0) {
      throw new AppError(
        'INSTALL_BUSY',
        'No se puede comprobar una instalación mientras hay una operación en curso.'
      )
    }
    const aggregate = this.options.catalog.repository.getAggregate(gameId)
    if (!aggregate) throw new AppError('PACKAGE_NOT_FOUND', 'El juego no existe en el catálogo.')
    const installRow = aggregate.install
    if (!installRow?.install_dir) {
      throw new AppError('INSTALL_INVALID_STATE', 'No hay una instalación registrada para comprobar.')
    }
    const packageRow = this.options.catalog.repository.getPackageRow(installRow.package_key)
    if (!packageRow) {
      throw new AppError('PACKAGE_UNAVAILABLE', 'No se encuentra el manifiesto usado en la instalación.')
    }
    const manifest = parsePackage(packageRow).manifest
    const snapshot = await revalidateInstalledGame(manifest, installRow.install_dir)
    const previous = this.repository.getSnapshot(gameId)
    const merged: InstallSnapshot = {
      ...previous,
      ...snapshot,
      startedAt: previous?.startedAt,
      finishedAt: snapshot.state === 'installed' ? new Date().toISOString() : previous?.finishedAt,
      logPath: previous?.logPath,
      updatedAt: new Date().toISOString(),
      rebootRequired: false
    }
    this.repository.saveSnapshot(gameId, installRow.package_key, merged)
    this.currentSnapshots.set(gameId, merged)
    if (merged.state === 'installed') {
      const parsedGame = parseGame(aggregate.game)
      if (parsedGame.steam.enabled) {
        this.options.catalog.repository.setSteamGameState(gameId, {
          ...parsedGame.steam,
          syncState: parsedGame.steam.syncState === 'synced' ? 'synced' : 'pending'
        })
      }
    }
    this.options.onInstallProgress?.(gameId, merged)
    this.options.onCatalogChanged?.('install-revalidated', gameId)
    const updated = this.options.catalog.getGame(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return updated
  }

  async launch(gameId: string): Promise<void> {
    const aggregate = this.options.catalog.repository.getAggregate(gameId)
    if (!aggregate) throw new AppError('PACKAGE_NOT_FOUND', 'El juego no existe en el catálogo.')
    const install = this.repository.getSnapshot(gameId)
    if (!install || install.state !== 'installed' || !install.installDir) {
      throw new AppError(
        'INSTALL_INVALID_STATE',
        'El juego no está instalado o su estado requiere una comprobación antes de lanzarlo.'
      )
    }
    const packageRow = this.options.catalog.repository.getPackageRow(
      this.repository.getRow(gameId)?.package_key ?? ''
    )
    if (!packageRow) throw new AppError('PACKAGE_UNAVAILABLE', 'Falta el manifiesto de la instalación.')
    const command = await buildLaunchCommand(parsePackage(packageRow).manifest, install.installDir)
    this.options.log.info(`Lanzando ${gameId}: ${command.executable}`)
    const child = spawn(command.executable, command.arguments, {
      cwd: command.workingDirectory,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.once('error', (error) => {
      this.options.log.error(`No se pudo lanzar ${gameId}: ${error.message}`)
    })
    child.unref()
  }

  isBusy(): boolean {
    return this.activeGameId !== null || this.startingGameId !== null || this.repository.getActiveCount() > 0
  }

  /** Usado solo para diagnóstico y pruebas. */
  pidIsAlive(pid?: number): boolean {
    return this.testPidAlive(pid)
  }
}
