import { watch, type FSWatcher } from 'node:fs'
import { access, copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CatalogGame } from '@shared/domain'
import { AppError, isAppError } from '@shared/errors'
import { isPathInside } from '@shared/safe-path'
import { inspectPackage } from '../package/package-service'
import type { FileLog } from '../logging/install-log'
import { CatalogRepository } from '../storage/catalog-repository'
import type { AppDatabase } from '../storage/database'
import type { SettingsRepository } from '../storage/settings-repository'
import type { AppPaths } from '../config/app-paths'
import { getCatalogGame } from './catalog-mapper'

export interface PackageScanIssue {
  filePath: string
  code: string
  message: string
}

export interface ScanSummary {
  startedAt: string
  finishedAt: string
  seen: number
  imported: number
  importedGameIds: string[]
  duplicates: number
  unavailable: number
  issues: PackageScanIssue[]
}

export interface CatalogServiceOptions {
  database: AppDatabase
  paths: AppPaths
  settings: SettingsRepository
  log: FileLog
  onChanged?: (reason: string, gameId?: string) => void
  onGameImported?: (gameId: string, packageKey: string) => void
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/[\\/]+/g, '\\').toLowerCase()
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function waitForStableFile(
  filePath: string,
  attempts = 5,
  intervalMs = 700
): Promise<{ size: number; mtimeMs: number } | null> {
  let previous: { size: number; mtimeMs: number } | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const current = await stat(filePath)
      if (!current.isFile()) return null
      if (
        previous &&
        previous.size === current.size &&
        Math.abs(previous.mtimeMs - current.mtimeMs) < 2
      ) {
        return { size: current.size, mtimeMs: current.mtimeMs }
      }
      previous = { size: current.size, mtimeMs: current.mtimeMs }
    } catch {
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
}

export class CatalogService {
  readonly repository: CatalogRepository
  private scanInFlight: Promise<ScanSummary> | null = null
  private watchers: FSWatcher[] = []
  private watchTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private readonly options: CatalogServiceOptions) {
    this.repository = new CatalogRepository(options.database)
  }

  getGames(): CatalogGame[] {
    return this.repository
      .listAggregates()
      .map((aggregate) => getCatalogGame(aggregate))
      .filter((game): game is CatalogGame => game !== null)
  }

  getGame(gameId: string): CatalogGame | null {
    const aggregate = this.repository.getAggregate(gameId)
    return aggregate ? getCatalogGame(aggregate) : null
  }

  async scan(): Promise<ScanSummary> {
    if (this.scanInFlight) return this.scanInFlight
    this.scanInFlight = this.performScan().finally(() => {
      this.scanInFlight = null
    })
    return this.scanInFlight
  }

  private notifyChanged(reason: string, gameId?: string): void {
    try {
      this.options.onChanged?.(reason, gameId)
    } catch (error) {
      this.options.log.warn(`No se pudo emitir el evento de catálogo: ${String(error)}`)
    }
  }

  private async performScan(): Promise<ScanSummary> {
    const startedAt = new Date().toISOString()
    const summary: ScanSummary = {
      startedAt,
      finishedAt: startedAt,
      seen: 0,
      imported: 0,
      importedGameIds: [],
      duplicates: 0,
      unavailable: 0,
      issues: []
    }
    const settings = this.options.settings.get()
    const knownByPath = new Map(
      this.repository
        .listAllPackageRows()
        .map((row) => [normalizePath(row.file_path), row] as const)
    )
    const scannedRoots: string[] = []
    const seenPackageKeys = new Set<string>()

    for (const folder of settings.packageFolders) {
      const absoluteFolder = path.resolve(folder)
      try {
        await mkdir(absoluteFolder, { recursive: true })
        const entries = await readdir(absoluteFolder, { withFileTypes: true })
        scannedRoots.push(absoluteFolder)
        const files = entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.game'))
          .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        for (const entry of files) {
          const filePath = path.join(absoluteFolder, entry.name)
          try {
            const nowStats = await stat(filePath).catch(() => null)
            if (!nowStats?.isFile()) continue
            const known = knownByPath.get(normalizePath(filePath))
            if (
              known &&
              known.file_size === nowStats.size &&
              Math.abs(known.file_mtime_ms - nowStats.mtimeMs) < 2
            ) {
              this.repository.touchPackage(known.key)
              if (known.available !== 1) this.repository.markPackageAvailable(known.key)
              seenPackageKeys.add(known.key)
              summary.seen += 1
              continue
            }

            const stable = await waitForStableFile(filePath)
            if (!stable) {
              summary.issues.push({
                filePath,
                code: 'PACKAGE_INCOMPLETE',
                message:
                  'El archivo no tiene un tamaño estable; puede seguir copiándose. Se volverá a intentar.'
              })
              continue
            }
            const inspected = await inspectPackage(filePath)
            const after = await stat(filePath).catch(() => null)
            if (
              !after ||
              after.size !== inspected.size ||
              Math.abs(after.mtimeMs - inspected.mtimeMs) > 2
            ) {
              summary.issues.push({
                filePath,
                code: 'PACKAGE_INCOMPLETE',
                message: 'El paquete cambió durante su lectura; se reintentará en el próximo escaneo.'
              })
              continue
            }

            const existing = this.repository.findPackageByVersion(
              inspected.manifest.id,
              inspected.manifest.version
            )
            if (existing && existing.sha256 !== inspected.sha256) {
              summary.issues.push({
                filePath,
                code: 'PACKAGE_VERSION_CONFLICT',
                message: `El paquete ${inspected.manifest.id} ${inspected.manifest.version} ya existe con otro contenido. No se ha sustituido. Usa una versión distinta o elimina el conflicto manualmente.`
              })
              continue
            }

            let relocate = false
            if (existing && normalizePath(existing.file_path) !== normalizePath(filePath)) {
              if (!(await pathExists(existing.file_path))) {
                relocate = true
              }
            }

            const result = this.repository.registerPackage(inspected, {
              relocateExisting: relocate
            })
            summary.seen += 1
            seenPackageKeys.add(result.packageKey)
            if (result.status === 'created' || result.status === 'version_added') {
              summary.imported += 1
              summary.importedGameIds.push(result.gameId)
              this.options.log.info(
                `Paquete importado: ${inspected.manifest.id}@${inspected.manifest.version} (${filePath})`
              )
              this.notifyChanged('package-imported', result.gameId)
              try {
                this.options.onGameImported?.(result.gameId, result.packageKey)
              } catch (error) {
                this.options.log.warn(
                  `No se pudo encolar metadatos para ${result.gameId}: ${String(error)}`
                )
              }
            } else {
              summary.duplicates += 1
              this.options.log.info(
                `Paquete duplicado (sin cambios): ${inspected.manifest.id}@${inspected.manifest.version}`
              )
            }
            const updatedRow = this.repository.findPackageByVersion(
              inspected.manifest.id,
              inspected.manifest.version
            )
            if (updatedRow) knownByPath.set(normalizePath(filePath), updatedRow)
          } catch (error) {
            const appError = isAppError(error)
              ? error
              : new AppError('PACKAGE_INVALID', 'No se pudo importar el paquete.', {
                  cause: error instanceof Error ? error.message : String(error)
                })
            summary.issues.push({
              filePath,
              code: appError.code,
              message: appError.message
            })
            this.options.log.warn(`Error importando ${filePath}: [${appError.code}] ${appError.message}`)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        summary.issues.push({
          filePath: absoluteFolder,
          code: 'IO_ERROR',
          message: `No se pudo leer la carpeta de paquetes: ${message}`
        })
        this.options.log.warn(`No se pudo escanear ${absoluteFolder}: ${message}`)
      }
    }

    const affected = this.repository.markMissingFromScan(scannedRoots, seenPackageKeys)
    summary.unavailable = affected.length
    for (const gameId of affected) this.notifyChanged('package-missing', gameId)
    summary.finishedAt = new Date().toISOString()
    this.notifyChanged('scan-finished')
    this.options.log.info(
      `Escaneo completado: ${summary.seen} vistos, ${summary.imported} importados, ${summary.duplicates} duplicados, ${summary.issues.length} incidencias.`
    )
    return summary
  }

  async importExternalFile(sourcePath: string): Promise<ScanSummary> {
    const settings = this.options.settings.get()
    if (settings.packageFolders.length === 0) {
      throw new AppError(
        'SETTINGS_INVALID',
        'Configura al menos una carpeta de paquetes antes de importar.'
      )
    }
    const absoluteSource = path.resolve(sourcePath)
    if (
      settings.packageFolders.some((folder) => isPathInside(path.resolve(folder), absoluteSource))
    ) {
      this.options.log.info(
        `El paquete ya está en una carpeta configurada; se escanea sin copiarlo: ${absoluteSource}`
      )
      return this.scan()
    }
    const folder = path.resolve(settings.packageFolders[0] ?? '')
    await mkdir(folder, { recursive: true })
    const fileName = path.basename(absoluteSource)
    if (!fileName.toLowerCase().endsWith('.game')) {
      throw new AppError('PACKAGE_INVALID', 'El archivo seleccionado no tiene extensión .game.')
    }
    let destination = path.join(folder, fileName)
    let index = 1
    while (await pathExists(destination)) {
      const parsed = path.parse(fileName)
      destination = path.join(folder, `${parsed.name}-${index}${parsed.ext}`)
      index += 1
    }
    await copyFile(absoluteSource, destination)
    this.options.log.info(`Paquete copiado a la carpeta configurada: ${destination}`)
    return this.scan()
  }

  startWatching(): void {
    if (this.watchers.length > 0) return
    this.stopped = false
    const schedule = (): void => {
      if (this.stopped) return
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null
        void this.scan().catch((error: unknown) => {
          this.options.log.error(`Error en escaneo automático: ${String(error)}`)
        })
      }, 1800)
    }
    for (const folder of this.options.settings.get().packageFolders) {
      try {
        const watcher = watch(folder, { persistent: true }, schedule)
        watcher.on('error', (error) => {
          this.options.log.warn(`Watcher de paquetes detenido para ${folder}: ${error.message}`)
        })
        this.watchers.push(watcher)
      } catch (error) {
        this.options.log.warn(
          `No se pudo vigilar la carpeta ${folder}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  stopWatching(): void {
    this.stopped = true
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }
}
