import { Transform, type Readable } from 'node:stream'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { AppError } from '@shared/errors'
import { checkRelativePath, isPathInside } from '@shared/safe-path'

export interface ZipLimits {
  maxEntries: number
  maxTotalUncompressedBytes: number
  maxEntryUncompressedBytes: number
  maxCompressionRatio: number
  maxPathLength: number
  maxManifestBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalUncompressedBytes: 128 * 1024 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024 * 1024,
  maxCompressionRatio: 2_000,
  maxPathLength: 1_024,
  maxManifestBytes: 1024 * 1024
}

export type ZipIssueKind = 'unsafe' | 'limit' | 'unsupported'

export interface ZipEntryIssue {
  fileName: string
  kind: ZipIssueKind
  message: string
}

export interface SafeZipEntry {
  fileName: string
  normalizedPath: string
  directory: boolean
  size: number
  compressedSize: number
  entry: Entry
}

export interface ZipPlan {
  entries: SafeZipEntry[]
  directories: SafeZipEntry[]
  files: SafeZipEntry[]
  totalUncompressedBytes: number
  totalCompressedBytes: number
}

export interface ZipPlanResult {
  ok: boolean
  issues: ZipEntryIssue[]
  plan?: ZipPlan
}

function dirnameOfZipPath(value: string): string {
  const index = value.lastIndexOf('/')
  return index === -1 ? '' : value.slice(0, index)
}

function isUnixSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000
  return mode === 0o120000
}

/**
 * Valida la lista de entradas contra límites y reglas de seguridad. No escribe
 * nada. Los nombres se comparan de forma case-insensitive porque el destino es
 * Windows y dos entradas que colisionan podrían sobrescribirse.
 */
export function planZipEntries(entries: Entry[], limits: Partial<ZipLimits> = {}): ZipPlanResult {
  const effectiveLimits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits }
  const issues: ZipEntryIssue[] = []
  const planEntries: SafeZipEntry[] = []
  const seen = new Map<string, SafeZipEntry>()
  const files = new Set<string>()
  const directories = new Set<string>()
  let totalUncompressedBytes = 0
  let totalCompressedBytes = 0

  if (entries.length > effectiveLimits.maxEntries) {
    issues.push({
      fileName: '',
      kind: 'limit',
      message: `El ZIP contiene ${entries.length} entradas; el límite es ${effectiveLimits.maxEntries}.`
    })
    return { ok: false, issues }
  }

  for (const entry of entries) {
    const isDirectory = entry.fileName.endsWith('/')
    const rawPath = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName
    const label = `La entrada ZIP "${entry.fileName}"`
    const checked = checkRelativePath(rawPath, {
      label,
      maxLength: effectiveLimits.maxPathLength
    })
    if (!checked.ok) {
      issues.push({ fileName: entry.fileName, kind: 'unsafe', message: checked.reason })
      continue
    }
    if (rawPath.length > 0 && (entry.fileName.includes('\\') || entry.fileName.includes('\0'))) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsafe',
        message: `${label} contiene separadores o caracteres no permitidos.`
      })
      continue
    }
    if (isUnixSymlink(entry)) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsafe',
        message: `${label} es un enlace simbólico; no se permiten enlaces en paquetes.`
      })
      continue
    }
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsupported',
        message: `${label} está cifrada; no se admiten ZIP cifrados.`
      })
      continue
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsupported',
        message: `${label} usa un método de compresión no admitido (${entry.compressionMethod}).`
      })
      continue
    }
    if (isDirectory && entry.uncompressedSize !== 0) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsafe',
        message: `${label} figura como directorio pero contiene datos.`
      })
      continue
    }
    if (entry.uncompressedSize > effectiveLimits.maxEntryUncompressedBytes) {
      issues.push({
        fileName: entry.fileName,
        kind: 'limit',
        message: `${label} supera el tamaño máximo por archivo (${entry.uncompressedSize} bytes).`
      })
      continue
    }
    if (
      !isDirectory &&
      entry.uncompressedSize > 1024 * 1024 &&
      (entry.compressedSize === 0 ||
        entry.uncompressedSize / Math.max(1, entry.compressedSize) > effectiveLimits.maxCompressionRatio)
    ) {
      issues.push({
        fileName: entry.fileName,
        kind: 'limit',
        message: `${label} tiene una ratio de compresión sospechosa; posible ZIP bomb.`
      })
      continue
    }

    const key = checked.value.normalize('NFC').toLowerCase()
    if (seen.has(key)) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsafe',
        message: `${label} colisiona con otra entrada (misma ruta en Windows).`
      })
      continue
    }

    const segments = checked.value.split('/')
    let blockedByFile = false
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/').normalize('NFC').toLowerCase()
      if (files.has(prefix)) {
        blockedByFile = true
        break
      }
    }
    if (blockedByFile) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsafe',
        message: `${label} intenta usar un archivo como directorio.`
      })
      continue
    }
    if (!isDirectory && directories.has(key)) {
      issues.push({
        fileName: entry.fileName,
        kind: 'unsafe',
        message: `${label} colisiona con un directorio existente.`
      })
      continue
    }

    const safeEntry: SafeZipEntry = {
      fileName: entry.fileName,
      normalizedPath: checked.value,
      directory: isDirectory,
      size: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      entry
    }
    seen.set(key, safeEntry)
    if (isDirectory) {
      directories.add(key)
    } else {
      files.add(key)
    }
    const parentKey = dirnameOfZipPath(checked.value)
    if (parentKey) directories.add(parentKey.normalize('NFC').toLowerCase())
    planEntries.push(safeEntry)
    totalUncompressedBytes += entry.uncompressedSize
    totalCompressedBytes += entry.compressedSize
  }

  if (totalUncompressedBytes > effectiveLimits.maxTotalUncompressedBytes) {
    issues.push({
      fileName: '',
      kind: 'limit',
      message: `El contenido descomprimido (${totalUncompressedBytes} bytes) supera el límite permitido.`
    })
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    issues: [],
    plan: {
      entries: planEntries,
      directories: planEntries.filter((entry) => entry.directory),
      files: planEntries.filter((entry) => !entry.directory),
      totalUncompressedBytes,
      totalCompressedBytes
    }
  }
}

/**
 * Lee el directorio central del ZIP y valida sus entradas. Mantiene el archivo
 * abierto hasta llamar a close() para poder abrir streams bajo demanda.
 */
export class ZipArchive {
  private closed = false

  private constructor(
    private readonly zipFile: ZipFile,
    readonly entries: Entry[],
    readonly plan: ZipPlan
  ) {}

  static async open(filePath: string, limits: Partial<ZipLimits> = {}): Promise<ZipArchive> {
    const zipFile = await new Promise<ZipFile>((resolve, reject) => {
      yauzl.open(
        filePath,
        {
          lazyEntries: true,
          autoClose: false,
          decodeStrings: true,
          validateEntrySizes: true
        },
        (error, opened) => {
          if (error || !opened) {
            reject(
              new AppError('PACKAGE_UNREADABLE', 'No se pudo abrir el paquete como ZIP.', {
                cause: error?.message
              })
            )
            return
          }
          resolve(opened)
        }
      )
    })

    const entries: Entry[] = []
    const effectiveLimits = { ...DEFAULT_ZIP_LIMITS, ...limits }
    if (zipFile.entryCount > effectiveLimits.maxEntries) {
      zipFile.close()
      throw new AppError(
        'EXTRACT_LIMIT',
        `El ZIP declara ${zipFile.entryCount} entradas; el límite es ${effectiveLimits.maxEntries}.`
      )
    }
    try {
      await new Promise<void>((resolve, reject) => {
        zipFile.on('error', (error) => {
          reject(
            new AppError('PACKAGE_CORRUPT', 'El ZIP está dañado o no es un ZIP válido.', {
              cause: error.message
            })
          )
        })
        zipFile.on('entry', (entry) => {
          entries.push(entry)
          zipFile.readEntry()
        })
        zipFile.on('end', () => resolve())
        zipFile.readEntry()
      })
    } catch (error) {
      zipFile.close()
      throw error
    }

    const result = planZipEntries(entries, limits)
    if (!result.ok || !result.plan) {
      zipFile.close()
      const first = result.issues[0]
      const kind = result.issues.some((issue) => issue.kind === 'limit') ? 'limit' : 'unsafe'
      throw new AppError(
        kind === 'limit' ? 'EXTRACT_LIMIT' : 'EXTRACT_UNSAFE',
        first?.message ?? 'El ZIP contiene entradas no seguras.',
        { details: { issues: result.issues.slice(0, 20) } }
      )
    }

    return new ZipArchive(zipFile, entries, result.plan)
  }

  find(normalizedPath: string): SafeZipEntry | undefined {
    const key = normalizedPath.normalize('NFC').toLowerCase()
    return this.plan.entries.find(
      (entry) => entry.normalizedPath.normalize('NFC').toLowerCase() === key
    )
  }

  async readFile(normalizedPath: string, maxBytes: number): Promise<Buffer> {
    const entry = this.find(normalizedPath)
    if (!entry || entry.directory) {
      throw new AppError('PACKAGE_INVALID', `No existe el archivo ${normalizedPath} dentro del paquete.`)
    }
    if (entry.size > maxBytes) {
      throw new AppError('PACKAGE_INVALID', `${normalizedPath} supera el tamaño permitido.`)
    }
    const stream = await this.openStream(entry)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > maxBytes) {
          throw new AppError('PACKAGE_INVALID', `${normalizedPath} supera el tamaño permitido.`)
        }
        chunks.push(buffer)
      }
    } finally {
      stream.destroy()
    }
    return Buffer.concat(chunks)
  }

  openStream(entry: SafeZipEntry): Promise<Readable> {
    return new Promise((resolve, reject) => {
      this.zipFile.openReadStream(entry.entry, (error, stream) => {
        if (error || !stream) {
          reject(
            new AppError('PACKAGE_CORRUPT', 'No se pudo leer una entrada del ZIP.', {
              cause: error?.message,
              details: { entry: entry.normalizedPath }
            })
          )
          return
        }
        resolve(stream)
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.zipFile.close()
  }
}

export interface ExtractOptions {
  destination: string
  signal?: AbortSignal
  limits?: Partial<ZipLimits>
  /** Recibe bytes completados y total. La UI decide cómo mostrar el progreso. */
  onProgress?: (completedBytes: number, totalBytes: number) => void
}

export interface ExtractResult {
  destination: string
  extractedBytes: number
  extractedFiles: number
  extractedDirectories: number
}

/**
 * Extrae un ZIP completo a un directorio exclusivo, validando cada entrada y
 * el destino real. El llamador debe crear el directorio temporal y limpiarlo
 * si esta función falla.
 */
export async function extractZip(
  packagePath: string,
  options: ExtractOptions
): Promise<ExtractResult> {
  const destination = path.resolve(options.destination)
  const archive = await ZipArchive.open(packagePath, options.limits)
  let extractedBytes = 0
  let extractedFiles = 0
  let extractedDirectories = 0
  const assertNotAborted = (): void => {
    if (options.signal?.aborted) {
      throw new AppError('EXTRACT_CANCELLED', 'Extracción cancelada.')
    }
  }

  try {
    await mkdir(destination, { recursive: true })
    const realDestination = await realpath(destination)

    for (const entry of archive.plan.directories) {
      assertNotAborted()
      const target = path.resolve(realDestination, ...entry.normalizedPath.split('/'))
      if (!isPathInside(realDestination, target)) {
        throw new AppError('EXTRACT_UNSAFE', 'Una entrada intentó salir del directorio de extracción.')
      }
      await mkdir(target, { recursive: true })
      extractedDirectories += 1
    }

    for (const entry of archive.plan.files) {
      assertNotAborted()
      const target = path.resolve(realDestination, ...entry.normalizedPath.split('/'))
      if (!isPathInside(realDestination, target)) {
        throw new AppError('EXTRACT_UNSAFE', 'Una entrada intentó salir del directorio de extracción.')
      }
      await mkdir(path.dirname(target), { recursive: true })
      const source = await archive.openStream(entry)
      let writtenForEntry = 0
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (options.signal?.aborted) {
            callback(new AppError('EXTRACT_CANCELLED', 'Extracción cancelada.'))
            return
          }
          writtenForEntry += chunk.length
          extractedBytes += chunk.length
          if (writtenForEntry > entry.size) {
            callback(new AppError('EXTRACT_UNSAFE', 'Una entrada produjo más datos de los declarados.'))
            return
          }
          options.onProgress?.(extractedBytes, archive.plan.totalUncompressedBytes)
          callback(null, chunk)
        }
      })
      try {
        await pipeline(
          source,
          counter,
          createWriteStream(target, { flags: 'wx', mode: 0o644 }),
          options.signal ? { signal: options.signal } : {}
        )
      } catch (error) {
        source.destroy()
        if (options.signal?.aborted) {
          throw new AppError('EXTRACT_CANCELLED', 'Extracción cancelada.')
        }
        if (error instanceof AppError) throw error
        throw new AppError('EXTRACT_FAILED', `No se pudo extraer ${entry.normalizedPath}.`, {
          cause: error instanceof Error ? error.message : String(error)
        })
      }
      const stats = await stat(target)
      if (!stats.isFile() || stats.size !== entry.size) {
        throw new AppError(
          'EXTRACT_FAILED',
          `El archivo extraído ${entry.normalizedPath} no tiene el tamaño declarado.`
        )
      }
      extractedFiles += 1
    }

    return { destination, extractedBytes, extractedFiles, extractedDirectories }
  } finally {
    archive.close()
  }
}
