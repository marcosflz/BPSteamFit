import { readFile, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, posix, win32 } from 'node:path'
import { AppError } from '@shared/errors'
import {
  getArtworkFileName,
  normalizeArtworkExtension,
  STEAM_ARTWORK_EXTENSIONS,
  STEAM_ARTWORK_KINDS,
  toUnsignedAppId,
  type SteamArtworkKind
} from './appid'
import {
  copyFileAtomic,
  createTimestampedBackup,
  fileExists,
  sha256Buffer,
  writeFileAtomic,
  type TimestampedBackupOptions
} from './fs-atomic'
import { parseAccountId, steamGridDirectory } from './paths'

export interface ArtworkItem {
  appId: number
  kind: SteamArtworkKind
  /** Archivo local de origen; no se mueve ni se borra. */
  sourcePath: string
}

export interface AppliedArtwork {
  appId: number
  kind: SteamArtworkKind
  sourcePath: string
  targetPath: string
  sha256: string
  bytes: number
  backupPath?: string
}

export interface SkippedArtwork {
  appId: number
  kind: SteamArtworkKind
  sourcePath: string
  targetPath: string
  reason: 'already-applied' | 'source-is-target'
}

export interface ApplyArtworkResult {
  applied: AppliedArtwork[]
  skipped: SkippedArtwork[]
  warnings: string[]
}

export interface ArtworkFsDeps {
  writeFileAtomic?: typeof writeFileAtomic
  createBackup?: typeof createTimestampedBackup
  sha256Buffer?: typeof sha256Buffer
  fileExists?: typeof fileExists
  readFile?: typeof readFile
  stat?: typeof stat
  unlink?: typeof unlink
}

export interface ApplyArtworkOptions extends TimestampedBackupOptions {
  backupDir?: string
  gridDir?: string
  maxBytes?: number
  deps?: ArtworkFsDeps
}

export interface RemoveArtworkOptions extends TimestampedBackupOptions {
  backupDir?: string
  gridDir?: string
  /** Si se indica, solo se borra cuando el hash actual coincide. */
  expectedHashes?: Record<string, string>
  dryRun?: boolean
  deps?: ArtworkFsDeps
}

export interface RemovedArtwork {
  appId: number
  kind: SteamArtworkKind
  path: string
  backupPath?: string
}

export interface RemoveArtworkResult {
  removed: RemovedArtwork[]
  skipped: Array<{ appId: number; kind: SteamArtworkKind; path: string; reason: string }>
  warnings: string[]
}

const DEFAULT_ARTWORK_MAX_BYTES = 64 * 1024 * 1024

function isAbsoluteAnywhere(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path)
}

function artworkError(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('ARTWORK_INVALID', message, { details })
}

function validateKind(kind: string): SteamArtworkKind {
  if (!(STEAM_ARTWORK_KINDS as readonly string[]).includes(kind)) {
    throw artworkError(`Tipo de artwork no soportado: ${kind}`, {
      supported: [...STEAM_ARTWORK_KINDS]
    })
  }
  return kind as SteamArtworkKind
}

function validateSourcePath(sourcePath: string): string {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw artworkError('La ruta de origen del artwork está vacía.')
  }
  if (/[\u0000\r\n]/.test(sourcePath)) {
    throw artworkError('La ruta de origen del artwork contiene caracteres no válidos.')
  }
  if (!isAbsoluteAnywhere(sourcePath)) {
    throw artworkError('La ruta de origen del artwork debe ser absoluta.', { sourcePath })
  }
  return sourcePath
}

export function getArtworkTargetPath(
  steamRoot: string,
  accountId: string | number,
  appId: number,
  kind: SteamArtworkKind,
  extension: string
): string {
  const grid = steamGridDirectory(steamRoot, parseAccountId(accountId))
  return join(grid, getArtworkFileName(appId, validateKind(kind), extension))
}

/**
 * Copia artwork a config/grid usando exclusivamente nombres canónicos de
 * AppIDs gestionados. Nunca mueve ni borra el archivo de origen. Antes de
 * reemplazar un destino distinto, crea backup si se proporciona backupDir.
 */
export async function applyArtwork(
  steamRoot: string,
  accountId: string | number,
  items: ArtworkItem[],
  options: ApplyArtworkOptions = {}
): Promise<ApplyArtworkResult> {
  if (!Array.isArray(items)) throw artworkError('Los items de artwork deben ser una lista.')
  const deps = options.deps ?? {}
  const read = deps.readFile ?? readFile
  const statFile = deps.stat ?? stat
  const write = deps.writeFileAtomic ?? writeFileAtomic
  const backup = deps.createBackup ?? createTimestampedBackup
  const exists = deps.fileExists ?? fileExists
  const hash = deps.sha256Buffer ?? sha256Buffer
  const gridDir = options.gridDir ?? steamGridDirectory(steamRoot, parseAccountId(accountId))
  const maxBytes = options.maxBytes ?? DEFAULT_ARTWORK_MAX_BYTES
  const seen = new Set<string>()
  const applied: AppliedArtwork[] = []
  const skipped: SkippedArtwork[] = []
  const warnings: string[] = []

  for (const item of items) {
    const appId = toUnsignedAppId(item.appId)
    if (appId === 0) throw artworkError('El AppID 0 no es válido para artwork.')
    const kind = validateKind(item.kind)
    const sourcePath = validateSourcePath(item.sourcePath)
    const duplicateKey = `${appId}:${kind}`
    if (seen.has(duplicateKey)) {
      throw artworkError(`Hay más de un artwork ${kind} para el AppID ${appId}.`, { appId, kind })
    }
    seen.add(duplicateKey)

    let sourceInfo
    try {
      sourceInfo = await statFile(sourcePath)
    } catch (error) {
      throw artworkError(`No se pudo leer el artwork de origen ${sourcePath}.`, {
        sourcePath,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
    if (!sourceInfo.isFile()) {
      throw artworkError(`El artwork de origen no es un archivo: ${sourcePath}.`, { sourcePath })
    }
    if (sourceInfo.size <= 0 || sourceInfo.size > maxBytes) {
      throw artworkError(`El artwork de origen tiene un tamaño no válido: ${sourceInfo.size} bytes.`, {
        sourcePath,
        size: sourceInfo.size,
        maxBytes
      })
    }
    const extension = normalizeArtworkExtension(extname(sourcePath))
    const targetPath = join(gridDir, getArtworkFileName(appId, kind, extension))
    if (targetPath === sourcePath) {
      skipped.push({
        appId,
        kind,
        sourcePath,
        targetPath,
        reason: 'source-is-target'
      })
      continue
    }

    const sourceBytes = await read(sourcePath)
    const sourceHash = await hash(sourceBytes)
    if (await exists(targetPath)) {
      try {
        const existingHash = await hash(await read(targetPath))
        if (existingHash === sourceHash) {
          skipped.push({ appId, kind, sourcePath, targetPath, reason: 'already-applied' })
          continue
        }
      } catch (error) {
        throw artworkError(`No se pudo comprobar el artwork existente ${targetPath}.`, {
          targetPath,
          cause: error instanceof Error ? error.message : String(error)
        })
      }
    }

    let backupPath: string | undefined
    let targetExisted = false
    if (options.backupDir) {
      const record = await backup(targetPath, join(options.backupDir, 'grid'), {
        ...(options.now ? { now: options.now } : {}),
        ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {}),
        ...(options.fsync !== undefined ? { fsync: options.fsync } : {})
      })
      if (record.existed) {
        backupPath = record.backupPath
        targetExisted = true
      }
    } else {
      targetExisted = await exists(targetPath)
    }

    try {
      const written = await write(targetPath, sourceBytes, {
        ...(options.fsync !== undefined ? { fsync: options.fsync } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {})
      })
      const persistedHash = await hash(await read(targetPath))
      if (persistedHash !== sourceHash || written.sha256 !== sourceHash) {
        throw artworkError('La validación posterior del artwork copiado ha fallado.', {
          targetPath,
          expectedSha256: sourceHash,
          actualSha256: persistedHash
        })
      }
      applied.push({
        appId,
        kind,
        sourcePath,
        targetPath,
        sha256: sourceHash,
        bytes: sourceBytes.length,
        ...(backupPath ? { backupPath } : {})
      })
    } catch (error) {
      // Best effort: restaurar el backup si existe; si no existía destino, no
      // se borra nada que no podamos identificar como nuestro.
      if (backupPath) {
        await copyFileAtomic(backupPath, targetPath).catch(() => undefined)
      } else if (!targetExisted) {
        await unlink(targetPath).catch(() => undefined)
      }
      throw error instanceof AppError
        ? error
        : artworkError(`No se pudo escribir el artwork ${targetPath}.`, {
            targetPath,
            cause: error instanceof Error ? error.message : String(error)
          })
    }
  }

  return { applied, skipped, warnings }
}

/**
 * Borra únicamente nombres canónicos de los AppIDs indicados explícitamente
 * como gestionados. No usa globs ni infiere AppIDs por nombre de juego.
 */
export async function removeManagedArtwork(
  steamRoot: string,
  accountId: string | number,
  appIds: number[],
  options: RemoveArtworkOptions = {}
): Promise<RemoveArtworkResult> {
  if (!Array.isArray(appIds)) throw artworkError('appIds debe ser una lista.')
  const deps = options.deps ?? {}
  const exists = deps.fileExists ?? fileExists
  const read = deps.readFile ?? readFile
  const hash = deps.sha256Buffer ?? sha256Buffer
  const remove = deps.unlink ?? unlink
  const backup = deps.createBackup ?? createTimestampedBackup
  const gridDir = options.gridDir ?? steamGridDirectory(steamRoot, parseAccountId(accountId))
  const removed: RemovedArtwork[] = []
  const skipped: RemoveArtworkResult['skipped'] = []
  const warnings: string[] = []
  const uniqueAppIds = [...new Set(appIds.map((appId) => toUnsignedAppId(appId)))]
  const extensions = [
    ...new Set(STEAM_ARTWORK_EXTENSIONS.map((extension) => (extension === '.jpeg' ? '.jpg' : extension)))
  ]

  for (const appId of uniqueAppIds) {
    if (appId === 0) {
      warnings.push('Se ignoró el AppID 0 en la limpieza de artwork.')
      continue
    }
    for (const kind of STEAM_ARTWORK_KINDS) {
      for (const normalizedExtension of extensions) {
        const path = join(gridDir, getArtworkFileName(appId, kind, normalizedExtension))
        if (!(await exists(path))) continue
        if (options.expectedHashes) {
          const expected =
            options.expectedHashes[path] ?? options.expectedHashes[basename(path)]
          if (!expected) {
            skipped.push({ appId, kind, path, reason: 'sin-hash-gestionado' })
            continue
          }
          const actual = await hash(await read(path))
          if (actual !== expected) {
            skipped.push({
              appId,
              kind,
              path,
              reason: 'hash-distinto-al-gestionado'
            })
            continue
          }
        }
        if (options.dryRun) {
          skipped.push({ appId, kind, path, reason: 'dry-run' })
          continue
        }
        let backupPath: string | undefined
        if (options.backupDir) {
          const record = await backup(path, join(options.backupDir, 'grid'), {
            ...(options.now ? { now: options.now } : {}),
            ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {}),
            ...(options.fsync !== undefined ? { fsync: options.fsync } : {})
          })
          if (record.existed) backupPath = record.backupPath
        }
        try {
          await remove(path)
          removed.push({ appId, kind, path, ...(backupPath ? { backupPath } : {}) })
        } catch (error) {
          warnings.push(
            `No se pudo borrar ${path}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
  }
  return { removed, skipped, warnings }
}

export interface MigrateArtworkOptions extends ApplyArtworkOptions {
  kinds?: SteamArtworkKind[]
  removeOld?: boolean
  expectedHashes?: Record<string, string>
}

export interface MigrateArtworkResult {
  copied: AppliedArtwork[]
  removedOld: RemovedArtwork[]
  warnings: string[]
}

/**
 * Estrategia de renombrado explícito cuando el AppID cambia: copia los nombres
 * canónicos del AppID antiguo al nuevo y, solo si removeOld=true, retira los
 * antiguos con backup y comprobación de hash. Nunca toca otros AppIDs.
 */
export async function migrateManagedArtwork(
  steamRoot: string,
  accountId: string | number,
  fromAppId: number,
  toAppId: number,
  options: MigrateArtworkOptions = {}
): Promise<MigrateArtworkResult> {
  const from = toUnsignedAppId(fromAppId)
  const to = toUnsignedAppId(toAppId)
  if (from === 0 || to === 0) throw artworkError('Los AppIDs de migración no pueden ser 0.')
  if (from === to) return { copied: [], removedOld: [], warnings: [] }
  const gridDir = options.gridDir ?? steamGridDirectory(steamRoot, parseAccountId(accountId))
  const kinds = options.kinds ?? [...STEAM_ARTWORK_KINDS]
  const exists = (options.deps?.fileExists ?? fileExists)
  const copied: AppliedArtwork[] = []
  const warnings: string[] = []

  const items: ArtworkItem[] = []
  for (const kind of kinds) {
    for (const extension of STEAM_ARTWORK_EXTENSIONS) {
      const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension
      const source = join(gridDir, getArtworkFileName(from, kind, normalizedExtension))
      if (await exists(source)) {
        items.push({ appId: to, kind, sourcePath: source })
        break
      }
    }
  }
  if (items.length === 0) {
    warnings.push(`No hay artwork canónico para migrar desde el AppID ${from}.`)
  } else {
    const result = await applyArtwork(steamRoot, accountId, items, options)
    copied.push(...result.applied)
    warnings.push(...result.warnings)
  }

  const removedOld: RemovedArtwork[] = []
  if (options.removeOld) {
    const removal = await removeManagedArtwork(steamRoot, accountId, [from], {
      ...(options.gridDir ? { gridDir: options.gridDir } : {}),
      ...(options.backupDir ? { backupDir: options.backupDir } : {}),
      ...(options.expectedHashes ? { expectedHashes: options.expectedHashes } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {}),
      ...(options.fsync !== undefined ? { fsync: options.fsync } : {}),
      ...(options.deps ? { deps: options.deps } : {})
    })
    removedOld.push(...removal.removed)
    warnings.push(...removal.warnings)
  }
  return { copied, removedOld, warnings }
}
