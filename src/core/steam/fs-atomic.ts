import { constants as fsConstants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AppError } from '@shared/errors'

export interface BackupRecord {
  sourcePath: string
  backupPath?: string
  existed: boolean
  sha256?: string
  createdAt: string
}

export interface AtomicWriteOptions {
  /** fsync del archivo temporal antes del rename (por defecto true). */
  fsync?: boolean
  now?: () => Date
  randomSuffix?: () => string
}

export interface AtomicWriteResult {
  path: string
  bytes: number
  sha256: string
}

export interface TimestampedBackupOptions {
  now?: () => Date
  randomSuffix?: () => string
  fsync?: boolean
}

function ioError(message: string, details: Record<string, unknown> = {}, cause?: unknown): AppError {
  return new AppError('IO_ERROR', message, {
    details,
    ...(cause !== undefined ? { cause } : {})
  })
}

export function defaultRandomSuffix(): string {
  return randomBytes(8).toString('hex')
}

export function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function sha256Buffer(buffer: Buffer): Promise<string> {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path))
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  // En Windows no se puede abrir un directorio como archivo; en POSIX es útil
  // para que el rename sobreviva a un corte. Se ignora si no está disponible.
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Best effort deliberado.
  }
}

/**
 * Escribe un archivo con temp + fsync + rename en el mismo directorio (mismo
 * volumen). Si algo falla, elimina el temporal y no toca el destino.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: Buffer,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  if (!Buffer.isBuffer(data)) throw ioError('Los datos atómicos deben ser un Buffer.')
  const directory = dirname(targetPath)
  const suffix = (options.randomSuffix ?? defaultRandomSuffix)()
  const tempPath = join(directory, `.${basename(targetPath)}.${process.pid}.${suffix}.tmp`)
  const hash = await sha256Buffer(data)
  try {
    await mkdir(directory, { recursive: true })
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(data)
      if (options.fsync ?? true) await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, targetPath)
    if (options.fsync ?? true) await syncDirectoryBestEffort(directory)
    return { path: targetPath, bytes: data.length, sha256: hash }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw ioError(`No se pudo escribir de forma atómica ${targetPath}.`, { targetPath }, error)
  }
}

/** Copia un archivo a otro creando el destino de forma atómica. */
export async function copyFileAtomic(
  sourcePath: string,
  targetPath: string,
  options: AtomicWriteOptions & { maxBytes?: number } = {}
): Promise<AtomicWriteResult> {
  let info
  try {
    info = await stat(sourcePath)
  } catch (error) {
    throw ioError(`No se pudo leer el origen ${sourcePath}.`, { sourcePath }, error)
  }
  if (!info.isFile()) throw ioError(`El origen no es un archivo: ${sourcePath}.`, { sourcePath })
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  if (info.size > maxBytes) {
    throw ioError(`El archivo supera ${maxBytes} bytes: ${sourcePath}.`, {
      sourcePath,
      size: info.size
    })
  }
  const buffer = await readFile(sourcePath)
  return writeFileAtomic(targetPath, buffer, options)
}

/**
 * Copia el archivo a un backup con timestamp y lo verifica por SHA-256. Si el
 * origen no existe, devuelve existed=false. Nunca sobrescribe un backup previo.
 */
export async function createTimestampedBackup(
  sourcePath: string,
  backupDir: string,
  options: TimestampedBackupOptions = {}
): Promise<BackupRecord> {
  const now = (options.now ?? (() => new Date()))()
  const createdAt = now.toISOString()
  let source: Buffer
  let info
  try {
    info = await stat(sourcePath)
    if (!info.isFile()) {
      throw ioError(`El origen del backup no es un archivo: ${sourcePath}`)
    }
    source = await readFile(sourcePath)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { sourcePath, existed: false, createdAt }
    }
    if (error instanceof AppError) throw error
    throw new AppError('STEAM_BACKUP_FAILED', `No se pudo leer ${sourcePath} para el backup.`, {
      details: { sourcePath, cause: error instanceof Error ? error.message : String(error) }
    })
  }
  const sourceHash = await sha256Buffer(source)
  try {
    await mkdir(backupDir, { recursive: true })
  } catch (error) {
    throw new AppError('STEAM_BACKUP_FAILED', `No se pudo crear el directorio de backup ${backupDir}.`, {
      details: { backupDir, cause: error instanceof Error ? error.message : String(error) }
    })
  }

  const randomSuffix = options.randomSuffix ?? defaultRandomSuffix
  let backupPath: string | undefined
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = join(
      backupDir,
      `${basename(sourcePath)}.${timestampForFile(now)}.${randomSuffix()}-${attempt}.bak`
    )
    try {
      await copyFile(sourcePath, candidate, fsConstants.COPYFILE_EXCL)
      backupPath = candidate
      break
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') continue
      throw new AppError('STEAM_BACKUP_FAILED', `No se pudo crear el backup de ${sourcePath}.`, {
        details: { sourcePath, candidate, cause: error instanceof Error ? error.message : String(error) }
      })
    }
  }
  if (!backupPath) {
    throw new AppError('STEAM_BACKUP_FAILED', `No se pudo reservar un nombre de backup para ${sourcePath}.`)
  }
  try {
    if (options.fsync ?? true) await syncFile(backupPath)
    const backupHash = await sha256File(backupPath)
    if (backupHash !== sourceHash) {
      throw new Error('El SHA-256 del backup no coincide con el origen.')
    }
    const backupStat = await stat(backupPath)
    if (backupStat.size !== source.length) {
      throw new Error('El tamaño del backup no coincide con el origen.')
    }
  } catch (error) {
    await unlink(backupPath).catch(() => undefined)
    throw new AppError('STEAM_BACKUP_FAILED', `El backup de ${sourcePath} no pasó la verificación.`, {
      details: { sourcePath, backupPath, cause: error instanceof Error ? error.message : String(error) }
    })
  }
  return {
    sourcePath,
    backupPath,
    existed: true,
    sha256: sourceHash,
    createdAt
  }
}

export async function restoreFromBackup(backupPath: string, targetPath: string): Promise<void> {
  await copyFileAtomic(backupPath, targetPath)
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  return writeFileAtomic(path, Buffer.from(json, 'utf8'), options)
}
