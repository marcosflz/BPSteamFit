import { spawn } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError, serializeError, type SerializedAppError } from '@shared/errors'
import type { SteamSyncResult } from '@shared/domain'
import { STEAM_ARTWORK_KINDS, toUnsignedAppId } from './appid'
import {
  applyArtwork as applyArtworkDefault,
  type ApplyArtworkResult,
  type ArtworkItem,
  type AppliedArtwork
} from './artwork'
import { writeJsonAtomic } from './fs-atomic'
import { assertAccountDirectory, createSteamProcessProbe } from './detect'
import {
  normalizeSteamRoot,
  parseAccountId,
  steamShortcutsPath
} from './paths'
import {
  applyShortcutPlan,
  normalizeShortcut,
  planShortcutChanges,
  readShortcutsFile as readShortcutsFileDefault,
  type ManagedShortcutRef,
  type ShortcutChange,
  type ShortcutCollision,
  type ShortcutDesired
} from './shortcuts'
import {
  writeShortcutsAtomic as writeShortcutsAtomicDefault,
  type WriteShortcutsResult
} from './shortcuts-write'

export type SteamSyncReopenPolicy = 'if-closed' | 'always' | 'never'
export type SteamSyncStateStatus = 'running' | 'completed' | 'failed' | 'aborted'
export type SteamSyncPhase =
  | 'starting'
  | 'closing'
  | 'waiting-for-close'
  | 'applying'
  | 'reopening'
  | 'finished'

export interface SteamSyncJob {
  schemaVersion?: 1
  id: string
  requestedAt?: string
  steamRoot: string
  steamExe?: string
  accountId: string | number
  /** Accesos deseados; la identidad gestionada se pasa en managedRefs. */
  desired: ShortcutDesired[]
  managedRefs?: ManagedShortcutRef[]
  artwork?: ArtworkItem[]
  backupDir: string
  statePath: string
  shutdownTimeoutMs?: number
  shutdownPollIntervalMs?: number
  reopen?: SteamSyncReopenPolicy
  tagMode?: 'merge' | 'replace'
  dryRun?: boolean
}

export interface SteamSyncState {
  schemaVersion: 1
  jobId: string
  status: SteamSyncStateStatus
  phase: SteamSyncPhase
  requestedAt: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  steamRoot: string
  accountId: string
  shortcutsPath: string
  steamWasRunning: boolean
  steamClosed: boolean
  steamRestarted: boolean
  backupPath?: string
  appliedGameIds: string[]
  managedAppIds: Record<string, number>
  collisions: ShortcutCollision[]
  artworkApplied: AppliedArtwork[]
  plannedChanges: Array<Pick<ShortcutChange, 'gameId' | 'action' | 'appId' | 'entryKey' | 'reason'>>
  error?: SerializedAppError
  reopenError?: SerializedAppError
  retryable: boolean
  warnings: string[]
  dryRun: boolean
  /** Copia del trabajo para que el coordinador pueda reintentar sin adivinar. */
  job: SteamSyncJob
}

export interface SteamSyncDeps {
  now: () => Date
  nowMs: () => number
  sleep: (ms: number) => Promise<void>
  isSteamRunning: () => Promise<boolean>
  requestSteamShutdown: () => Promise<void>
  launchSteamBigPicture: () => Promise<void>
  readShortcutsFile: typeof readShortcutsFileDefault
  writeShortcutsAtomic: typeof writeShortcutsAtomicDefault
  applyArtwork: typeof applyArtworkDefault
  writeState: (path: string, state: SteamSyncState) => Promise<void>
}

function defaultWriteState(path: string, state: SteamSyncState): Promise<void> {
  return writeJsonAtomic(path, state, { fsync: true }).then(() => undefined)
}

function requireSteamExe(job: SteamSyncJob): string {
  if (!job.steamExe) {
    throw new AppError('STEAM_NOT_FOUND', 'El trabajo no incluye steamExe para cerrar o abrir Steam.')
  }
  return job.steamExe
}

function spawnDetached(
  executable: string,
  args: string[],
  label: string,
  code: 'STEAM_SHUTDOWN_FAILED' | 'STEAM_SYNC_FAILED' = 'STEAM_SHUTDOWN_FAILED'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (error) => {
      reject(
        new AppError(code, `No se pudo ${label} Steam.`, {
          details: { executable, args, cause: error.message },
          cause: error
        })
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Dependencias reales del auxiliar. No las usa ningún test: el runner recibe
 * siempre sondas/deps inyectadas. `-shutdown` y `-bigpicture` son opciones
 * documentadas de Steam; no se usa taskkill ni terminación forzada.
 */
export function createDefaultSteamSyncDeps(job: SteamSyncJob): SteamSyncDeps {
  return {
    now: () => new Date(),
    nowMs: () => Date.now(),
    sleep: (ms) => delay(ms),
    isSteamRunning: () => createSteamProcessProbe().isRunning(),
    requestSteamShutdown: async () => {
      await spawnDetached(requireSteamExe(job), ['-shutdown'], 'cerrar')
    },
    launchSteamBigPicture: async () => {
      await spawnDetached(
        requireSteamExe(job),
        ['-bigpicture'],
        'abrir en Big Picture',
        'STEAM_SYNC_FAILED'
      )
    },
    readShortcutsFile: readShortcutsFileDefault,
    writeShortcutsAtomic: writeShortcutsAtomicDefault,
    applyArtwork: applyArtworkDefault,
    writeState: defaultWriteState
  }
}

function validationError(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_ERROR', message, { details })
}

function isAbsoluteAnywhere(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path)
}

function normalizeJob(job: SteamSyncJob): SteamSyncJob {
  if (!job || typeof job !== 'object') throw validationError('El trabajo de Steam no es un objeto.')
  if (typeof job.id !== 'string' || job.id.trim().length === 0) {
    throw validationError('El trabajo de Steam necesita un id.')
  }
  if (typeof job.steamRoot !== 'string' || job.steamRoot.trim().length === 0) {
    throw validationError('El trabajo de Steam necesita steamRoot.')
  }
  if (!isAbsoluteAnywhere(job.steamRoot)) {
    throw validationError('steamRoot debe ser una ruta absoluta.', { steamRoot: job.steamRoot })
  }
  const accountId = parseAccountId(job.accountId)
  if (!Array.isArray(job.desired)) throw validationError('desired debe ser una lista.')
  if (job.managedRefs !== undefined && !Array.isArray(job.managedRefs)) {
    throw validationError('managedRefs debe ser una lista.')
  }
  if (job.artwork !== undefined && !Array.isArray(job.artwork)) {
    throw validationError('artwork debe ser una lista.')
  }
  if (typeof job.backupDir !== 'string' || job.backupDir.trim().length === 0) {
    throw validationError('El trabajo de Steam necesita backupDir.')
  }
  if (!isAbsoluteAnywhere(job.backupDir)) {
    throw validationError('backupDir debe ser una ruta absoluta.')
  }
  if (typeof job.statePath !== 'string' || job.statePath.trim().length === 0) {
    throw validationError('El trabajo de Steam necesita statePath.')
  }
  if (!isAbsoluteAnywhere(job.statePath)) {
    throw validationError('statePath debe ser una ruta absoluta.')
  }
  // Validar los campos antes de cerrar Steam; el plan los volverá a normalizar.
  const gameIds = new Set<string>()
  for (const item of job.desired) {
    if (!item || typeof item !== 'object') {
      throw validationError('Cada elemento de desired debe ser un objeto.')
    }
    normalizeShortcut(item, 0)
    if (gameIds.has(item.gameId)) {
      throw validationError(`Hay dos juegos con el mismo gameId: ${item.gameId}`)
    }
    gameIds.add(item.gameId)
  }
  const refGameIds = new Set<string>()
  const refAppIds = new Set<number>()
  for (const ref of job.managedRefs ?? []) {
    if (!ref || typeof ref !== 'object' || typeof ref.gameId !== 'string') {
      throw validationError('Cada managedRef necesita gameId y appId.')
    }
    const appId = toUnsignedAppId(ref.appId)
    if (appId === 0) throw validationError('Una referencia gestionada no puede tener AppID 0.')
    if (refGameIds.has(ref.gameId) || refAppIds.has(appId)) {
      throw validationError('Hay referencias gestionadas duplicadas por gameId o appId.')
    }
    refGameIds.add(ref.gameId)
    refAppIds.add(appId)
  }
  for (const item of job.artwork ?? []) {
    if (!item || typeof item !== 'object') {
      throw validationError('Cada elemento de artwork debe ser un objeto.')
    }
    if (toUnsignedAppId(item.appId) === 0) {
      throw validationError('El artwork no puede usar AppID 0.')
    }
    if (!(STEAM_ARTWORK_KINDS as readonly string[]).includes(item.kind)) {
      throw validationError(`Tipo de artwork no soportado: ${String(item.kind)}`)
    }
    if (typeof item.sourcePath !== 'string' || !isAbsoluteAnywhere(item.sourcePath)) {
      throw validationError('Cada artwork necesita una ruta de origen absoluta.')
    }
  }
  const reopen = job.reopen ?? 'if-closed'
  if (reopen !== 'if-closed' && reopen !== 'always' && reopen !== 'never') {
    throw validationError(`Política de reapertura no válida: ${String(job.reopen)}`)
  }
  const tagMode = job.tagMode ?? 'merge'
  if (tagMode !== 'merge' && tagMode !== 'replace') {
    throw validationError(`tagMode no válido: ${String(job.tagMode)}`)
  }
  const shutdownTimeoutMs = job.shutdownTimeoutMs ?? 30_000
  const shutdownPollIntervalMs = job.shutdownPollIntervalMs ?? 500
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw validationError('shutdownTimeoutMs debe ser positivo.')
  }
  if (!Number.isFinite(shutdownPollIntervalMs) || shutdownPollIntervalMs < 1) {
    throw validationError('shutdownPollIntervalMs debe ser positivo.')
  }
  return {
    ...job,
    schemaVersion: 1,
    id: job.id.trim(),
    steamRoot: normalizeSteamRoot(job.steamRoot),
    accountId,
    managedRefs: job.managedRefs ?? [],
    artwork: job.artwork ?? [],
    desired: job.desired,
    reopen,
    tagMode,
    shutdownTimeoutMs,
    shutdownPollIntervalMs,
    dryRun: job.dryRun ?? false
  }
}

function initialState(job: SteamSyncJob, now: Date): SteamSyncState {
  const startedAt = now.toISOString()
  return {
    schemaVersion: 1,
    jobId: job.id,
    status: 'running',
    phase: 'starting',
    requestedAt: job.requestedAt ?? startedAt,
    startedAt,
    updatedAt: startedAt,
    steamRoot: job.steamRoot,
    accountId: String(job.accountId),
    shortcutsPath: steamShortcutsPath(job.steamRoot, String(job.accountId)),
    steamWasRunning: false,
    steamClosed: false,
    steamRestarted: false,
    appliedGameIds: [],
    managedAppIds: {},
    collisions: [],
    artworkApplied: [],
    plannedChanges: [],
    retryable: true,
    warnings: [],
    dryRun: job.dryRun ?? false,
    job
  }
}

function errorBackupPath(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined
  const backupPath = error.details?.backupPath
  return typeof backupPath === 'string' ? backupPath : undefined
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  return error instanceof AppError ? error.details : undefined
}

async function persist(
  deps: SteamSyncDeps,
  state: SteamSyncState,
  update: Partial<SteamSyncState> = {}
): Promise<SteamSyncState> {
  const next: SteamSyncState = {
    ...state,
    ...update,
    updatedAt: deps.now().toISOString()
  }
  await deps.writeState(next.job.statePath, next)
  return next
}

async function waitForSteamExit(
  job: SteamSyncJob,
  deps: SteamSyncDeps
): Promise<boolean> {
  const timeout = job.shutdownTimeoutMs ?? 30_000
  const poll = job.shutdownPollIntervalMs ?? 500
  const deadline = deps.nowMs() + timeout
  while (true) {
    if (!(await deps.isSteamRunning())) return true
    const remaining = deadline - deps.nowMs()
    if (remaining <= 0) return false
    await deps.sleep(Math.min(poll, remaining))
  }
}

function shouldReopen(job: SteamSyncJob, state: SteamSyncState): boolean {
  if (job.reopen === 'never') return false
  if (job.reopen === 'always') return true
  return state.steamWasRunning && state.steamClosed
}

function plansHaveConflicts(changes: ShortcutChange[]): boolean {
  return changes.some((change) => change.action === 'conflict')
}

export interface RunSteamSyncOptions {
  /** Permite sustituir solo una parte de las dependencias. */
  deps?: Partial<SteamSyncDeps>
}

/**
 * Orquestador puro (sin Electron): cierra Steam de forma normal, espera,
 * aborta sin matar si no cierra, hace backup y aplica shortcuts/artwork, y
 * reabre en Big Picture. El estado final siempre queda en statePath salvo que
 * falle la propia escritura del estado.
 */
export async function runSteamSync(
  inputJob: SteamSyncJob,
  options: RunSteamSyncOptions = {}
): Promise<SteamSyncState> {
  const job = normalizeJob(inputJob)
  const defaults = createDefaultSteamSyncDeps(job)
  const deps: SteamSyncDeps = { ...defaults, ...options.deps }
  let state = initialState(job, deps.now())
  await persist(deps, state)

  try {
    // Validar la cuenta antes de cerrar Steam: un accountId erróneo no debe
    // provocar un cierre ni crear directorios nuevos.
    await assertAccountDirectory(job.steamRoot, String(job.accountId))

    const wasRunning = await deps.isSteamRunning()
    state = await persist(deps, state, {
      steamWasRunning: wasRunning,
      phase: wasRunning ? 'closing' : 'applying'
    })

    if (wasRunning) {
      await deps.requestSteamShutdown()
      state = await persist(deps, state, { phase: 'waiting-for-close' })
      const closed = await waitForSteamExit(job, deps)
      if (!closed) {
        return await persist(deps, state, {
          status: 'aborted',
          phase: 'finished',
          steamClosed: false,
          completedAt: deps.now().toISOString(),
          retryable: true,
          warnings: [
            ...state.warnings,
            'No se forzó la terminación de Steam y no se modificaron shortcuts ni artwork.'
          ],
          error: serializeError(
            new AppError(
              'STEAM_SHUTDOWN_FAILED',
              `Steam no se cerró en ${job.shutdownTimeoutMs ?? 30_000} ms. No se forzó la terminación ni se modificó nada.`,
              {
                details: {
                  timeoutMs: job.shutdownTimeoutMs ?? 30_000,
                  steamRoot: job.steamRoot
                }
              }
            )
          )
        })
      }
      state = await persist(deps, state, { steamClosed: true, phase: 'applying' })
    }

    const snapshot = await deps.readShortcutsFile(state.shortcutsPath, { allowMissing: true })
    const plan = planShortcutChanges(snapshot.root, job.desired, job.managedRefs ?? [], {
      tagMode: job.tagMode ?? 'merge'
    })
    const managedAppIds = Object.fromEntries(
      plan.managedRefs.map((ref) => [ref.gameId, ref.appId])
    )
    state = await persist(deps, state, {
      managedAppIds,
      collisions: plan.collisions,
      warnings: [...state.warnings, ...plan.warnings],
      plannedChanges: plan.changes.map((change) => ({
        gameId: change.gameId,
        action: change.action,
        appId: change.appId,
        ...(change.entryKey ? { entryKey: change.entryKey } : {}),
        ...(change.reason ? { reason: change.reason } : {})
      }))
    })

    if (plansHaveConflicts(plan.changes)) {
      throw new AppError(
        'STEAM_SYNC_FAILED',
        'El plan contiene colisiones con entradas ajenas; no se modificó nada.',
        { details: { collisions: plan.collisions } }
      )
    }

    const managedArtworkIds = new Set(plan.managedRefs.map((ref) => ref.appId))
    for (const item of job.artwork ?? []) {
      if (!managedArtworkIds.has(toUnsignedAppId(item.appId))) {
        throw new AppError(
          'ARTWORK_INVALID',
          `El artwork del AppID ${item.appId} no corresponde a ningún shortcut gestionado del trabajo.`
        )
      }
    }

    const applied = applyShortcutPlan(snapshot.root, plan)
    const appliedGameIds = applied.applied.map((change) => change.gameId)

    if (!job.dryRun) {
      if (applied.applied.length > 0) {
        const writeResult: WriteShortcutsResult = await deps.writeShortcutsAtomic(
          state.shortcutsPath,
          applied.root,
          {
            backupDir: job.backupDir,
            expectedSha256: snapshot.sha256 ?? null
          }
        )
        state = await persist(deps, state, {
          appliedGameIds,
          ...(writeResult.backup?.backupPath ? { backupPath: writeResult.backup.backupPath } : {})
        })
      } else {
        state = await persist(deps, state, { appliedGameIds: [] })
      }

      if ((job.artwork ?? []).length > 0) {
        const artworkResult: ApplyArtworkResult = await deps.applyArtwork(
          job.steamRoot,
          String(job.accountId),
          job.artwork ?? [],
          { backupDir: job.backupDir }
        )
        state = await persist(deps, state, {
          artworkApplied: artworkResult.applied,
          warnings: [...state.warnings, ...artworkResult.warnings]
        })
      }
    } else {
      state = await persist(deps, state, {
        appliedGameIds: [],
        warnings: [...state.warnings, 'dryRun: no se escribieron shortcuts ni artwork.']
      })
    }

    state = await persist(deps, state, {
      status: 'completed',
      phase: 'finished',
      completedAt: deps.now().toISOString(),
      retryable: false
    })
  } catch (error) {
    const backupPath = errorBackupPath(error)
    state = await persist(deps, state, {
      status: 'failed',
      phase: 'finished',
      completedAt: deps.now().toISOString(),
      retryable: true,
      error: serializeError(error),
      ...(backupPath ? { backupPath } : {}),
      warnings: [
        ...state.warnings,
        ...(errorDetails(error)?.collisions ? ['El plan se detuvo por colisiones.'] : [])
      ]
    })
  }

  // Reapertura: se intenta después del éxito o del fallo de aplicación, pero
  // nunca tras un fallo de cierre. Con reopen=always también se abre si Steam
  // ya estaba cerrado al empezar.
  const mayReopen =
    shouldReopen(job, state) &&
    (state.steamClosed || (job.reopen === 'always' && state.status === 'completed'))
  if (mayReopen) {
    state = await persist(deps, state, { phase: 'reopening' })
    try {
      const alreadyRunning = await deps.isSteamRunning()
      if (alreadyRunning) {
        state = await persist(deps, state, {
          steamRestarted: false,
          warnings: [...state.warnings, 'Steam ya estaba en ejecución; no se relanzó.']
        })
      } else {
        await deps.launchSteamBigPicture()
        state = await persist(deps, state, { steamRestarted: true })
      }
    } catch (error) {
      state = await persist(deps, state, {
        steamRestarted: false,
        reopenError: serializeError(error),
        warnings: [...state.warnings, 'Los cambios se aplicaron, pero no se pudo reabrir Steam.']
      })
    }
  }

  return persist(deps, state, { phase: 'finished' })
}

/** Adapta el estado persistido al contrato compartido SteamSyncResult. */
export function steamSyncStateToResult(state: SteamSyncState): SteamSyncResult {
  return {
    id: state.jobId,
    status: state.status,
    requestedAt: state.requestedAt,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    appliedGameIds: state.appliedGameIds,
    ...(state.backupPath ? { backupPath: state.backupPath } : {}),
    ...(state.error ? { error: state.error } : {}),
    steamRestarted: state.steamRestarted
  }
}
