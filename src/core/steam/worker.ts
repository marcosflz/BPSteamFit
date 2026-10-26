import { readFile } from 'node:fs/promises'
import { AppError, serializeError, type SerializedAppError } from '@shared/errors'
import { writeJsonAtomic } from './fs-atomic'
import {
  runSteamSync,
  type SteamSyncDeps,
  type SteamSyncJob,
  type SteamSyncState
} from './sync'

export interface SteamWorkerFailureFile {
  schemaVersion: 1
  jobId?: string
  status: 'failed'
  phase: 'finished'
  requestedAt: string
  startedAt: string
  updatedAt: string
  completedAt: string
  error: SerializedAppError
  retryable: boolean
  jobPath: string
  statePath: string
}

export interface SteamSyncWorkerOptions {
  jobPath: string
  statePath: string
  deps?: Partial<SteamSyncDeps>
}

export interface SteamSyncWorkerResult {
  exitCode: number
  state?: SteamSyncState
  error?: SerializedAppError
  statePath: string
}

const MAX_JOB_BYTES = 2 * 1024 * 1024

function nowIso(): string {
  return new Date().toISOString()
}

async function writeFailureState(
  statePath: string,
  jobPath: string,
  error: unknown,
  jobId?: string,
  retryable = false
): Promise<SerializedAppError> {
  const at = nowIso()
  const serialized = serializeError(error)
  const failure: SteamWorkerFailureFile = {
    schemaVersion: 1,
    ...(jobId ? { jobId } : {}),
    status: 'failed',
    phase: 'finished',
    requestedAt: at,
    startedAt: at,
    updatedAt: at,
    completedAt: at,
    error: serialized,
    retryable,
    jobPath,
    statePath
  }
  await writeJsonAtomic(statePath, failure, { fsync: true })
  return serialized
}

/**
 * Runner auxiliar sin Electron ni SQLite. Lee un JSON de trabajo, ejecuta el
 * sync con dependencias reales (o inyectadas) y escribe el estado. Devuelve un
 * código de salida: 0 completado, 2 abortado, 1 fallido/entrada inválida.
 */
export async function runSteamSyncWorker(
  options: SteamSyncWorkerOptions
): Promise<SteamSyncWorkerResult> {
  if (!options.jobPath || !options.statePath) {
    throw new AppError('VALIDATION_ERROR', 'El worker necesita jobPath y statePath.')
  }
  let job: SteamSyncJob
  try {
    const info = await readFile(options.jobPath)
    if (info.length > MAX_JOB_BYTES) {
      throw new AppError('VALIDATION_ERROR', `El JSON de trabajo supera ${MAX_JOB_BYTES} bytes.`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(info.toString('utf8')) as unknown
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', 'El archivo de trabajo no contiene JSON válido.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('VALIDATION_ERROR', 'El JSON de trabajo debe ser un objeto.')
    }
    job = { ...(parsed as SteamSyncJob), statePath: options.statePath }
  } catch (error) {
    let serialized: SerializedAppError
    try {
      serialized = await writeFailureState(options.statePath, options.jobPath, error)
    } catch (writeError) {
      throw new AppError('IO_ERROR', 'No se pudo escribir el estado de fallo del worker.', {
        details: { statePath: options.statePath, cause: writeError instanceof Error ? writeError.message : String(writeError) }
      })
    }
    return { exitCode: 1, error: serialized, statePath: options.statePath }
  }

  try {
    const state = await runSteamSync(job, { deps: options.deps })
    const exitCode = state.status === 'completed' ? 0 : state.status === 'aborted' ? 2 : 1
    return { exitCode, state, statePath: options.statePath }
  } catch (error) {
    let serialized: SerializedAppError
    try {
      serialized = await writeFailureState(
        options.statePath,
        options.jobPath,
        error,
        typeof job.id === 'string' ? job.id : undefined,
        true
      )
    } catch (writeError) {
      throw new AppError('IO_ERROR', 'No se pudo escribir el estado de fallo del worker.', {
        details: { statePath: options.statePath, cause: writeError instanceof Error ? writeError.message : String(writeError) }
      })
    }
    return { exitCode: 1, error: serialized, statePath: options.statePath }
  }
}

/**
 * Entrada CLI: `worker-cli.ts <trabajo.json> <estado.json>`.
 * No implementa IPC ni usa Electron.
 */
export async function runSteamSyncWorkerFromArgv(
  argv: string[] = process.argv.slice(2),
  deps?: Partial<SteamSyncDeps>
): Promise<number> {
  const [jobPath, statePath] = argv
  if (!jobPath || !statePath) {
    process.stderr.write('Uso: worker-cli <trabajo.json> <estado.json>\n')
    return 2
  }
  const result = await runSteamSyncWorker({
    jobPath,
    statePath,
    ...(deps ? { deps } : {})
  })
  const summary = {
    exitCode: result.exitCode,
    statePath: result.statePath,
    ...(result.state ? { status: result.state.status, jobId: result.state.jobId } : {}),
    ...(result.error ? { errorCode: result.error.code } : {})
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  return result.exitCode
}
