import { spawn } from 'node:child_process'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  SteamAccount,
  SteamPendingChange,
  SteamStatus,
  SteamSyncResult
} from '@shared/domain'
import { AppError, isAppError, serializeError } from '@shared/errors'
import type { CatalogRepository } from '@core/storage/catalog-repository'
import type { ArtworkRepository } from '@core/storage/artwork-repository'
import type { FileArtworkStorage } from '@core/storage/artwork-storage'
import type { SettingsRepository } from '@core/storage/settings-repository'
import type { SteamRepository, SyncWorkerRecord } from '@core/storage/steam-repository'
import type { SteamSyncRow } from '@core/storage/types'
import { parseGame, parsePackage } from '@core/storage/parsers'
import type { AppPaths } from '@core/config/app-paths'
import type { FileLog } from '@core/logging/install-log'
import { buildLaunchCommand } from '@core/install/engine'
import { createShortcutIcon } from './ico'
import {
  assertAccountDirectory,
  detectSteamStatus,
  type SteamRootDetectionOptions
} from '@core/steam/detect'
import { readAccountShortcuts } from '@core/steam/shortcuts'
import {
  planShortcutChanges,
  type ManagedShortcutRef,
  type ShortcutChange,
  type ShortcutDesired
} from '@core/steam/shortcuts'
import type { ArtworkItem } from '@core/steam/artwork'
import type { SteamArtworkKind } from '@core/steam/appid'
import type { SteamSyncJob, SteamSyncState } from '@core/steam/sync'
import { buildWindowsCommandLine } from '@shared/windows-args'

const STEAM_ARTWORK_TO_APP: ReadonlyArray<{ app: 'portrait' | 'hero' | 'logo' | 'icon'; steam: SteamArtworkKind }> = [
  { app: 'portrait', steam: 'portrait' },
  { app: 'hero', steam: 'hero' },
  { app: 'logo', steam: 'logo' },
  { app: 'icon', steam: 'icon' }
]

export interface SteamServiceOptions {
  catalog: CatalogRepository
  artwork: ArtworkRepository
  artworkStorage: FileArtworkStorage
  settings: SettingsRepository
  steam: SteamRepository
  paths: AppPaths
  log: FileLog
  onChanged?: (status: SteamStatus) => void
  steamRootOverride?: string
  runningOverride?: boolean
  workerEntryPath?: string
  staleStateMs?: number
  launchWorker?: (jobPath: string, statePath: string) => Promise<void>
}

interface PreparedSync {
  steamRoot: string
  steamExe: string
  accountId: string
  desired: ShortcutDesired[]
  appIds: Map<string, number>
  changes: ShortcutChange[]
  pending: SteamPendingChange[]
  warnings: string[]
  conflicts: ShortcutChange[]
}

export interface SteamSyncStartResult {
  scheduled: boolean
  message: string
}

export class SteamService {
  private startingSync = false

  constructor(private readonly options: SteamServiceOptions) {}

  private detectionOptions(selectedAccountId?: string): SteamRootDetectionOptions & {
    selectedAccountId?: string
    running?: boolean
  } {
    return {
      steamRoot: this.options.steamRootOverride,
      disableRegistry: Boolean(this.options.steamRootOverride),
      ...(this.options.steamRootOverride
        ? {
            pathExists: async (candidate: string) => {
              try {
                await access(candidate)
                return true
              } catch {
                return false
              }
            }
          }
        : {}),
      ...(this.options.runningOverride === undefined
        ? {}
        : { running: this.options.runningOverride }),
      ...(selectedAccountId ? { selectedAccountId } : {})
    }
  }

  private chooseSteamAccount(
    accounts: SteamAccount[],
    statusSelected?: string
  ): { account?: SteamAccount; warning?: string } {
    const settings = this.options.settings.get()
    const bySettings = settings.selectedSteamAccountId
      ? accounts.find((account) => account.accountId === settings.selectedSteamAccountId)
      : undefined
    if (bySettings) return { account: bySettings }
    if (settings.selectedSteamAccountId) {
      return {
        account:
          accounts.find((account) => account.accountId === statusSelected) ??
          accounts.find((account) => account.isActive) ??
          accounts[0],
        warning: 'La cuenta de Steam configurada ya no existe; se usa el perfil activo.'
      }
    }
    return {
      account:
        accounts.find((account) => account.accountId === statusSelected) ??
        accounts.find((account) => account.isActive) ??
        accounts[0]
    }
  }

  private async baseStatus(): Promise<SteamStatus> {
    const settings = this.options.settings.get()
    const detected = await detectSteamStatus(
      this.detectionOptions(settings.selectedSteamAccountId)
    )
    const lastRow = this.options.steam.getLastSyncRow()
    const lastResult = lastRow ? this.options.steam.toResult(lastRow) : undefined
    if (!detected.installed || !detected.steamPath) {
      return {
        ...detected,
        pendingChanges: [],
        ...(lastResult ? { lastResult } : {})
      }
    }
    const selection = this.chooseSteamAccount(detected.accounts, detected.selectedAccountId)
    const warnings = [detected.warning, selection.warning].filter(
      (value): value is string => Boolean(value)
    )
    const accounts = detected.accounts.map((account) => ({
      ...account,
      isSelected: account.accountId === selection.account?.accountId
    }))
    return {
      ...detected,
      accounts,
      ...(selection.account ? { selectedAccountId: selection.account.accountId } : {}),
      pendingChanges: [],
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      ...(lastResult ? { lastResult } : {})
    }
  }

  private markStaleSync(row: SteamSyncRow, worker: SyncWorkerRecord, message: string): void {
    const now = new Date().toISOString()
    const synthetic: SteamSyncState = {
      schemaVersion: 1,
      jobId: worker.job.id,
      status: 'failed',
      phase: 'finished',
      requestedAt: row.requested_at,
      startedAt: row.started_at ?? now,
      updatedAt: now,
      completedAt: now,
      steamRoot: worker.job.steamRoot,
      accountId: String(worker.job.accountId),
      shortcutsPath: '',
      steamWasRunning: false,
      steamClosed: false,
      steamRestarted: false,
      appliedGameIds: [],
      managedAppIds: {},
      collisions: [],
      artworkApplied: [],
      plannedChanges: [],
      error: {
        code: 'STEAM_SYNC_FAILED',
        message
      },
      retryable: true,
      warnings: [],
      dryRun: false,
      job: worker.job
    }
    this.options.steam.applyWorkerState(row.id, synthetic)
    this.options.log.warn(message)
  }

  async processPendingResults(): Promise<void> {
    const staleMs = this.options.staleStateMs ?? 3 * 60 * 1000
    for (const row of this.options.steam.listRunningSyncRows()) {
      const worker = this.options.steam.getWorkerRecord(row)
      if (!worker) continue
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(worker.statePath, 'utf8')) as unknown
      } catch {
        try {
          const info = await stat(worker.statePath)
          if (Date.now() - info.mtimeMs > staleMs) {
            this.markStaleSync(
              row,
              worker,
              'El auxiliar de Steam no actualizó su estado; la sincronización se marcó como fallida para poder reintentar.'
            )
          }
        } catch {
          const age = Date.now() - Date.parse(row.requested_at)
          if (age > Math.max(staleMs * 2, 5 * 60 * 1000)) {
            this.markStaleSync(
              row,
              worker,
              'El auxiliar de Steam no dejó un estado final. Se puede reintentar la sincronización.'
            )
          }
        }
        continue
      }
      const maybeState = raw as Partial<SteamSyncState>
      if (maybeState.status === 'running') {
        try {
          const info = await stat(worker.statePath)
          if (Date.now() - info.mtimeMs > staleMs) {
            this.markStaleSync(
              row,
              worker,
              'El auxiliar de Steam dejó de actualizar el estado; no se volverá a bloquear la sincronización.'
            )
          }
        } catch {
          // Se reintentará la comprobación en la próxima apertura.
        }
        continue
      }
      if (!maybeState.status || !['completed', 'failed', 'aborted'].includes(maybeState.status)) {
        continue
      }
      try {
        if (!maybeState.job) {
          const synthetic: SteamSyncState = {
            schemaVersion: 1,
            jobId: worker.job.id,
            status: maybeState.status as SteamSyncState['status'],
            phase: 'finished',
            requestedAt: maybeState.requestedAt ?? row.requested_at,
            startedAt: maybeState.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: maybeState.completedAt ?? new Date().toISOString(),
            steamRoot: worker.job.steamRoot,
            accountId: String(worker.job.accountId),
            shortcutsPath: '',
            steamWasRunning: false,
            steamClosed: false,
            steamRestarted: maybeState.steamRestarted ?? false,
            appliedGameIds: maybeState.appliedGameIds ?? [],
            managedAppIds: maybeState.managedAppIds ?? {},
            collisions: maybeState.collisions ?? [],
            artworkApplied: maybeState.artworkApplied ?? [],
            plannedChanges: maybeState.plannedChanges ?? [],
            error: maybeState.error,
            retryable: maybeState.retryable ?? true,
            warnings: maybeState.warnings ?? [],
            dryRun: false,
            job: worker.job
          }
          this.options.steam.applyWorkerState(row.id, synthetic)
        } else {
          this.options.steam.applyWorkerState(row.id, maybeState as SteamSyncState)
        }
        this.options.log.info(
          `Resultado de sincronización Steam ${row.id}: ${maybeState.status}.`
        )
      } catch (error) {
        this.options.log.warn(
          `No se pudo aplicar el estado del auxiliar Steam ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  }

  async getStatus(): Promise<SteamStatus> {
    await this.processPendingResults()
    const base = await this.baseStatus()
    if (!base.installed) return base
    const runningSync = this.options.steam.listRunningSyncRows().length > 0
    try {
      const prepared = await this.buildPlan(base.selectedAccountId, false)
      return {
        ...base,
        selectedAccountId: prepared.accountId,
        pendingChanges: prepared.pending,
        ...(prepared.warnings.length > 0 || prepared.conflicts.length > 0 || runningSync
          ? {
              warning: [
                base.warning,
                runningSync ? 'Hay una sincronización de Steam en curso.' : undefined,
                ...prepared.warnings,
                ...prepared.conflicts.map((conflict) => conflict.reason ?? 'Conflicto de acceso')
              ]
                .filter((value): value is string => Boolean(value))
                .join(' ')
            }
          : {})
      }
    } catch (error) {
      const message = isAppError(error) ? error.message : String(error)
      this.options.log.warn(`No se pudo preparar el estado de Steam: ${message}`)
      return {
        ...base,
        warning: [base.warning, message].filter((value): value is string => Boolean(value)).join(' ')
      }
    }
  }

  async refreshAccounts(): Promise<SteamAccount[]> {
    return (await this.getStatus()).accounts
  }

  async selectAccount(accountId: string): Promise<SteamStatus> {
    const base = await this.baseStatus()
    const account = base.accounts.find((entry) => entry.accountId === accountId)
    if (!account) {
      throw new AppError('STEAM_PROFILE_NOT_FOUND', 'El perfil de Steam seleccionado no existe.')
    }
    this.options.settings.update({ selectedSteamAccountId: accountId })
    return this.getStatus()
  }

  private async buildPlan(
    selectedAccountId: string | undefined,
    forJob: boolean
  ): Promise<PreparedSync> {
    const base = await this.baseStatus()
    if (!base.installed || !base.steamPath) {
      throw new AppError('STEAM_NOT_FOUND', 'No se encontró una instalación de Steam.')
    }
    const selection = this.chooseSteamAccount(base.accounts, base.selectedAccountId)
    if (!selection.account) {
      throw new AppError(
        'STEAM_PROFILE_NOT_FOUND',
        'No hay perfiles de Steam en userdata. Abre Steam al menos una vez con una cuenta.'
      )
    }
    const accountId = selection.account.accountId
    const steamRoot = base.steamPath
    const steamExe = path.join(steamRoot, 'steam.exe')
    try {
      await access(steamExe)
    } catch {
      throw new AppError('STEAM_NOT_FOUND', 'No se encontró steam.exe en la instalación detectada.')
    }
    await assertAccountDirectory(steamRoot, accountId)
    const snapshot = await readAccountShortcuts(steamRoot, accountId, { allowMissing: true })
    const managedRefs = this.options.steam.listManagedRefs(accountId)
    const desired: ShortcutDesired[] = []
    const warnings: string[] = []
    const steamByGame = new Map<string, ReturnType<typeof parseGame>>()

    for (const aggregate of this.options.catalog.listAggregates()) {
      const parsedGame = parseGame(aggregate.game)
      steamByGame.set(parsedGame.id, parsedGame)
      const install = aggregate.install
      if (!install || install.state !== 'installed' || !install.install_dir) continue
      if (!parsedGame.steam.enabled) continue
      const packageRow = this.options.catalog.getPackageRow(install.package_key)
      if (!packageRow) {
        warnings.push(`Falta el manifiesto de la instalación de ${parsedGame.name}.`)
        continue
      }
      const manifest = parsePackage(packageRow).manifest
      let command
      try {
        command = await buildLaunchCommand(manifest, install.install_dir)
      } catch (error) {
        warnings.push(
          `No se prepara el acceso de ${parsedGame.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        continue
      }
      const iconRow = this.options.artwork.getChosenRow(parsedGame.id, 'icon')
      let iconPath = command.executable
      if (iconRow) {
        iconPath = path.join(
          this.options.paths.userData,
          'shortcut-icons',
          `${parsedGame.id.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'game'}.ico`
        )
        if (forJob) {
          const previewKey = this.options.artwork.getPreviewKey(iconRow.id)
          const previewPath = previewKey
            ? await this.options.artworkStorage.resolveFile(previewKey)
            : null
          if (previewPath) {
            try {
              await createShortcutIcon(previewPath, path.dirname(iconPath), parsedGame.id)
            } catch (error) {
              warnings.push(
                `No se pudo generar el icono .ico de ${parsedGame.name}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
              iconPath = command.executable
            }
          } else {
            iconPath = command.executable
          }
        }
      }

      desired.push({
        gameId: parsedGame.id,
        appName: (parsedGame.steam.displayName || parsedGame.name).slice(0, 200),
        exePath: command.executable,
        startDir: command.workingDirectory,
        launchOptions: command.arguments.length > 0 ? buildWindowsCommandLine(command.arguments) : '',
        iconPath,
        tags: parsedGame.steam.tags ?? []
      })
    }

    const plan = planShortcutChanges(snapshot.root, desired, managedRefs, {
      tagMode: 'merge',
      allowAppIdFallback: true
    })
    warnings.push(...plan.warnings)
    const appIds = new Map<string, number>()
    const changesByGame = new Map<string, ShortcutChange>()
    for (const change of plan.changes) {
      changesByGame.set(change.gameId, change)
      if (change.action !== 'conflict') appIds.set(change.gameId, change.appId)
    }
    const conflicts = plan.changes.filter((change) => change.action === 'conflict')
    const pending: SteamPendingChange[] = []
    for (const change of plan.changes) {
      if (change.action === 'add' || change.action === 'update') {
        pending.push({
          gameId: change.gameId,
          gameName: change.normalized.appName,
          action: change.action,
          reason: change.action === 'add' ? 'Añadir acceso externo' : 'Actualizar acceso externo',
          shortcutAppId: change.appId
        })
      } else if (change.action === 'conflict') {
        pending.push({
          gameId: change.gameId,
          gameName: change.normalized.appName,
          action: 'update',
          reason: change.reason ?? 'Conflicto con un acceso no gestionado',
          shortcutAppId: change.appId
        })
      } else if (change.action === 'unchanged') {
        const parsedGame = steamByGame.get(change.gameId)
        const lastSync = parsedGame?.steam.lastSyncedAt
          ? Date.parse(parsedGame.steam.lastSyncedAt)
          : 0
        const chosen = this.options.artwork.getChosenViews(change.gameId)
        const artworkNewer = Object.values(chosen).some((view) => {
          if (!view) return false
          return Date.parse(view.createdAt) > lastSync
        })
        const needsRetry = parsedGame?.steam.syncState === 'pending' || parsedGame?.steam.syncState === 'failed'
        if (artworkNewer || needsRetry) {
          pending.push({
            gameId: change.gameId,
            gameName: change.normalized.appName,
            action: 'update',
            reason: artworkNewer ? 'Artwork actualizado' : 'Sincronización pendiente',
            shortcutAppId: change.appId
          })
        }
      }
    }

    const jobDesired = desired
      .filter((entry) => appIds.has(entry.gameId))
      .map((entry) => ({ ...entry, appId: appIds.get(entry.gameId) }))

    let artwork: ArtworkItem[] = []
    if (forJob) {
      for (const entry of jobDesired) {
        const appId = appIds.get(entry.gameId)
        if (!appId) continue
        for (const mapping of STEAM_ARTWORK_TO_APP) {
          const row = this.options.artwork.getChosenRow(entry.gameId, mapping.app)
          if (!row?.chosen) continue
          const key = this.options.artwork.getPreviewKey(row.id)
          if (!key) continue
          const sourcePath = await this.options.artworkStorage.resolveFile(key)
          if (!sourcePath) {
            warnings.push(`Falta el archivo de artwork ${mapping.app} de ${entry.appName}.`)
            continue
          }
          artwork.push({ appId, kind: mapping.steam, sourcePath })
        }
      }
    }

    return {
      steamRoot,
      steamExe,
      accountId,
      desired: jobDesired,
      appIds,
      changes: plan.changes,
      pending,
      warnings,
      conflicts
    }
  }

  private workerEntryPath(): string {
    return this.options.workerEntryPath ?? path.join(__dirname, 'sync-worker.js')
  }

  private async defaultLaunchWorker(jobPath: string, statePath: string): Promise<void> {
    const workerPath = this.workerEntryPath()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, jobPath, statePath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      child.once('error', (error) => {
        reject(
          new AppError('STEAM_SYNC_FAILED', 'No se pudo lanzar el auxiliar de sincronización.', {
            cause: error.message
          })
        )
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  async prepareSync(): Promise<SteamStatus> {
    return this.getStatus()
  }

  async startSync(confirmed: boolean): Promise<SteamSyncStartResult> {
    if (!confirmed) {
      throw new AppError(
        'VALIDATION_ERROR',
        'La sincronización con Steam requiere confirmación explícita.'
      )
    }
    if (this.startingSync) {
      throw new AppError('STEAM_BUSY', 'Ya hay una sincronización de Steam en preparación.')
    }
    this.startingSync = true
    try {
      return await this.startSyncInternal()
    } finally {
      this.startingSync = false
    }
  }

  private async startSyncInternal(): Promise<SteamSyncStartResult> {
    await this.processPendingResults()
    if (this.options.steam.listRunningSyncRows().length > 0) {
      throw new AppError(
        'STEAM_BUSY',
        'Ya hay una sincronización de Steam en curso. Espera a que termine.'
      )
    }
    const prepared = await this.buildPlan(undefined, true)
    if (prepared.conflicts.length > 0) {
      throw new AppError(
        'STEAM_SYNC_FAILED',
        'Hay conflictos con accesos no gestionados. No se ha modificado ningún acceso.',
        {
          details: {
            conflicts: prepared.conflicts.map((change) => ({
              gameId: change.gameId,
              appId: change.appId,
              reason: change.reason
            }))
          }
        }
      )
    }
    if (prepared.pending.length === 0) {
      return { scheduled: false, message: 'No hay cambios pendientes para Steam.' }
    }

    const id = `sync-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`
    const jobPath = path.join(this.options.paths.steamSync, `${id}-job.json`)
    const statePath = path.join(this.options.paths.steamSync, `${id}-state.json`)
    const job: SteamSyncJob = {
      schemaVersion: 1,
      id,
      requestedAt: new Date().toISOString(),
      steamRoot: prepared.steamRoot,
      steamExe: prepared.steamExe,
      accountId: prepared.accountId,
      desired: prepared.desired,
      managedRefs: prepared.appIds.size > 0 ? [...prepared.appIds.entries()].map(([gameId, appId]) => ({ gameId, appId })) : [],
      artwork: [],
      backupDir: this.options.paths.steamBackups,
      statePath,
      shutdownTimeoutMs: 30_000,
      shutdownPollIntervalMs: 500,
      reopen: 'always',
      tagMode: 'merge'
    }
    // El artwork debe construirse con los appIds definitivos del plan.
    job.artwork = await this.collectArtwork(prepared.desired)
    await mkdir(this.options.paths.steamSync, { recursive: true })
    await mkdir(this.options.paths.steamBackups, { recursive: true })
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    const record: SyncWorkerRecord = { job, jobPath, statePath }
    this.options.steam.createSyncRunning(id, record)
    try {
      if (this.options.launchWorker) {
        await this.options.launchWorker(jobPath, statePath)
      } else {
        await this.defaultLaunchWorker(jobPath, statePath)
      }
    } catch (error) {
      const serialized = serializeError(error)
      this.options.steam.updateSync(id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: serialized
      })
      throw isAppError(error)
        ? error
        : new AppError('STEAM_SYNC_FAILED', 'No se pudo iniciar el auxiliar de sincronización.', {
            cause: String(error)
          })
    }
    this.options.log.info(
      `Sincronización Steam programada: ${id} (${prepared.pending.length} cambios pendientes).`
    )
    return {
      scheduled: true,
      message:
        'Sincronización programada. La app se cerrará, Steam se cerrará de forma normal y se reabrirá en Big Picture. Si Steam no se cierra, no se modificará nada.'
    }
  }

  private async collectArtwork(desired: ShortcutDesired[]): Promise<ArtworkItem[]> {
    const artwork: ArtworkItem[] = []
    for (const entry of desired) {
      if (entry.appId === undefined) continue
      for (const mapping of STEAM_ARTWORK_TO_APP) {
        const row = this.options.artwork.getChosenRow(entry.gameId, mapping.app)
        if (!row?.chosen) continue
        const key = this.options.artwork.getPreviewKey(row.id)
        if (!key) continue
        const sourcePath = await this.options.artworkStorage.resolveFile(key)
        if (!sourcePath) continue
        artwork.push({ appId: entry.appId, kind: mapping.steam, sourcePath })
      }
    }
    return artwork
  }

  async getLastResult(): Promise<SteamSyncResult | null> {
    await this.processPendingResults()
    const row = this.options.steam.getLastSyncRow()
    return row ? this.options.steam.toResult(row) : null
  }
}
