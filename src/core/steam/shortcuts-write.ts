import { readFile, unlink } from 'node:fs/promises'
import { AppError } from '@shared/errors'
import { serializeShortcutsVdf, vdfObjectsEqual, type VdfObject } from './binary-vdf'
import {
  createTimestampedBackup,
  fileExists,
  restoreFromBackup,
  sha256Buffer,
  writeFileAtomic,
  type BackupRecord,
  type TimestampedBackupOptions
} from './fs-atomic'
import { parseAccountId, steamShortcutsPath } from './paths'
import { readShortcutsFile, type ShortcutsFileSnapshot } from './shortcuts'

export interface ShortcutsWriterDeps {
  readShortcutsFile?: typeof readShortcutsFile
  serialize?: (root: VdfObject) => Buffer
  writeFileAtomic?: typeof writeFileAtomic
  createBackup?: (sourcePath: string, backupDir: string, options?: TimestampedBackupOptions) => Promise<BackupRecord>
  restoreFromBackup?: typeof restoreFromBackup
  sha256Buffer?: typeof sha256Buffer
  fileExists?: typeof fileExists
  unlink?: (path: string) => Promise<void>
}

export interface WriteShortcutsOptions {
  backupDir: string
  /** Hash del archivo leído; null si no existía. Evita pisar cambios ajenos. */
  expectedSha256?: string | null
  now?: () => Date
  randomSuffix?: () => string
  fsync?: boolean
  deps?: ShortcutsWriterDeps
}

export interface WriteShortcutsResult {
  path: string
  created: boolean
  bytes: number
  sha256: string
  backup?: BackupRecord
  restored?: boolean
}

interface RestoreOutcome {
  restored: boolean
  restoreError?: string
}

async function restoreIfPossible(
  path: string,
  backup: BackupRecord | undefined,
  newHash: string,
  deps: ShortcutsWriterDeps
): Promise<RestoreOutcome> {
  try {
    if (backup?.backupPath) {
      await (deps.restoreFromBackup ?? restoreFromBackup)(backup.backupPath, path)
      return { restored: true }
    }
    // Si no había archivo original, solo se elimina si el contenido actual es
    // exactamente el que acabamos de escribir; nunca se borra algo ajeno.
    const exists = await (deps.fileExists ?? fileExists)(path)
    if (!exists) return { restored: true }
    const currentHash = await (deps.sha256Buffer ?? sha256Buffer)(await readFile(path))
    if (currentHash === newHash) {
      await (deps.unlink ?? unlink)(path)
      return { restored: true }
    }
    return {
      restored: false,
      restoreError:
        'No había backup y el destino contiene datos que esta operación no reconoce como propios.'
    }
  } catch (error) {
    return {
      restored: false,
      restoreError: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Escribe shortcuts.vdf:
 * 1. comprueba el hash esperado para detectar carreras,
 * 2. hace backup con timestamp del archivo actual,
 * 3. serializa y valida,
 * 4. escribe temp + fsync + rename,
 * 5. vuelve a leer y compara; si no coincide, restaura el backup.
 */
export async function writeShortcutsAtomic(
  path: string,
  root: VdfObject,
  options: WriteShortcutsOptions
): Promise<WriteShortcutsResult> {
  if (!options.backupDir) {
    throw new AppError('STEAM_BACKUP_FAILED', 'writeShortcutsAtomic necesita un backupDir.')
  }
  const deps = options.deps ?? {}
  const read = deps.readShortcutsFile ?? readShortcutsFile
  const serialize = deps.serialize ?? serializeShortcutsVdf
  const write = deps.writeFileAtomic ?? writeFileAtomic
  const backup = deps.createBackup ?? createTimestampedBackup
  const hashBuffer = deps.sha256Buffer ?? sha256Buffer

  const snapshot: ShortcutsFileSnapshot = await read(path, { allowMissing: true })
  const currentHash = snapshot.sha256 ?? null
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== currentHash) {
    throw new AppError(
      'STEAM_BUSY',
      'shortcuts.vdf cambió desde que se leyó; no se sobrescribe.',
      { details: { path, expectedSha256: options.expectedSha256, currentSha256: currentHash } }
    )
  }

  // Serializar antes del backup evita crear un backup si el modelo es inválido.
  const bytes = serialize(root)
  const newHash = await hashBuffer(bytes)

  let backupRecord: BackupRecord | undefined
  if (snapshot.exists) {
    backupRecord = await backup(path, options.backupDir, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {}),
      ...(options.fsync !== undefined ? { fsync: options.fsync } : {})
    })
    if (!backupRecord.existed || !backupRecord.backupPath) {
      throw new AppError('STEAM_BACKUP_FAILED', 'El backup no se creó correctamente.', {
        details: { path }
      })
    }
  }

  try {
    const writeResult = await write(path, bytes, {
      ...(options.fsync !== undefined ? { fsync: options.fsync } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {})
    })
    const persisted = await read(path, { allowMissing: false })
    const persistedHash = persisted.sha256
    if (
      !persistedHash ||
      persistedHash !== newHash ||
      !persisted.exists ||
      !vdfObjectsEqual(root, persisted.root)
    ) {
      throw new AppError(
        'STEAM_SYNC_FAILED',
        'La validación posterior de shortcuts.vdf ha fallado.',
        {
          details: {
            path,
            expectedSha256: newHash,
            actualSha256: persistedHash ?? null,
            backupPath: backupRecord?.backupPath ?? null
          }
        }
      )
    }
    return {
      path,
      created: !snapshot.exists,
      bytes: writeResult.bytes,
      sha256: newHash,
      ...(backupRecord?.backupPath ? { backup: backupRecord } : {})
    }
  } catch (error) {
    const outcome = await restoreIfPossible(path, backupRecord, newHash, deps)
    const message =
      error instanceof AppError
        ? error.message
        : `No se pudo escribir shortcuts.vdf: ${error instanceof Error ? error.message : String(error)}`
    const details = {
      ...(error instanceof AppError ? error.details : {}),
      path,
      backupPath: backupRecord?.backupPath ?? null,
      restored: outcome.restored,
      ...(outcome.restoreError ? { restoreError: outcome.restoreError } : {}),
      cause: error instanceof Error ? error.message : String(error)
    }
    if (!outcome.restored) {
      throw new AppError('STEAM_BACKUP_FAILED', `La escritura falló y no se pudo restaurar: ${message}`, {
        details,
        cause: error
      })
    }
    throw new AppError(
      error instanceof AppError ? error.code : 'STEAM_SYNC_FAILED',
      message,
      { details, cause: error }
    )
  }
}

export async function writeAccountShortcutsAtomic(
  steamRoot: string,
  accountId: string | number,
  root: VdfObject,
  options: WriteShortcutsOptions
): Promise<WriteShortcutsResult> {
  return writeShortcutsAtomic(
    steamShortcutsPath(steamRoot, parseAccountId(accountId)),
    root,
    options
  )
}
