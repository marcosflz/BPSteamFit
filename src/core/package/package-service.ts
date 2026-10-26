import { createReadStream, createWriteStream } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import yazl from 'yazl'
import { AppError, isAppError } from '@shared/errors'
import { compareVersions, validateManifest, type Manifest, type ManifestIssue } from '@shared/manifest'
import { checkRelativePath, isPathInside } from '@shared/safe-path'
import { sha256File } from '../fs/hash'
import { DEFAULT_ZIP_LIMITS, ZipArchive, type ZipLimits } from './zip'

export interface InspectedPackage {
  filePath: string
  fileName: string
  size: number
  sha256: string
  manifest: Manifest
  warnings: string[]
  entryCount: number
  payloadBytes: number
  payloadFiles: number
  mtimeMs: number
}

export interface InspectOptions {
  limits?: Partial<ZipLimits>
  /** Permite evitar el hash en comprobaciones rápidas de escaneo. */
  skipHash?: boolean
  signal?: AbortSignal
}

function packageErrorFromZip(error: unknown): AppError {
  if (isAppError(error)) {
    if (error.code === 'EXTRACT_UNSAFE' || error.code === 'EXTRACT_LIMIT') {
      return new AppError('PACKAGE_INVALID', error.message, {
        details: error.details,
        cause: error
      })
    }
    if (error.code === 'PACKAGE_CORRUPT') {
      const cause = typeof error.cause === 'string' ? error.cause : ''
      if (/invalid relative path|absolute path|invalid characters in fileName|invalid file name/i.test(cause)) {
        return new AppError(
          'PACKAGE_INVALID',
          'El ZIP contiene nombres de archivo no seguros (rutas absolutas, ".." o separadores no permitidos).',
          { cause }
        )
      }
    }
    return error
  }
  return new AppError('PACKAGE_INVALID', 'El paquete no es válido.', { cause: error })
}

function validateStructure(
  archive: ZipArchive
): { payloadFiles: number; payloadBytes: number; entryCount: number } {
  const manifestEntries = archive.plan.files.filter(
    (entry) => entry.normalizedPath.toLowerCase() === 'manifest.json'
  )
  if (manifestEntries.length !== 1) {
    throw new AppError('PACKAGE_INVALID', 'El paquete debe contener manifest.json en la raíz.')
  }

  let payloadFiles = 0
  let payloadBytes = 0
  for (const entry of archive.plan.entries) {
    const normalized = entry.normalizedPath
    if (normalized.toLowerCase() === 'manifest.json') {
      if (entry.directory) {
        throw new AppError('PACKAGE_INVALID', 'manifest.json no puede ser un directorio.')
      }
      continue
    }
    if (normalized === 'payload') {
      if (!entry.directory) {
        throw new AppError('PACKAGE_INVALID', 'payload debe ser un directorio.')
      }
      continue
    }
    if (!normalized.startsWith('payload/')) {
      throw new AppError(
        'PACKAGE_INVALID',
        `Entrada no permitida en la raíz del paquete: ${normalized}. Solo se admite manifest.json y payload/.`
      )
    }
    if (!entry.directory) {
      payloadFiles += 1
      payloadBytes += entry.size
    }
  }

  if (payloadFiles === 0) {
    throw new AppError('PACKAGE_INVALID', 'El paquete no contiene ningún archivo dentro de payload/.')
  }

  return { payloadFiles, payloadBytes, entryCount: archive.plan.entries.length }
}

export async function inspectPackage(
  filePath: string,
  options: InspectOptions = {}
): Promise<InspectedPackage> {
  const absolutePath = path.resolve(filePath)
  let stats
  try {
    stats = await stat(absolutePath)
  } catch (error) {
    throw new AppError('PACKAGE_NOT_FOUND', `No se encontró el paquete: ${absolutePath}`, {
      cause: error
    })
  }
  if (!stats.isFile()) {
    throw new AppError('PACKAGE_INVALID', 'La ruta del paquete no es un archivo.')
  }
  if (stats.size === 0) {
    throw new AppError('PACKAGE_CORRUPT', 'El paquete está vacío.')
  }

  let archive: ZipArchive
  try {
    archive = await ZipArchive.open(absolutePath, options.limits)
  } catch (error) {
    throw packageErrorFromZip(error)
  }

  try {
    const structure = validateStructure(archive)
    const manifestEntry = archive.find('manifest.json')
    if (!manifestEntry) {
      throw new AppError('PACKAGE_INVALID', 'Falta manifest.json en el paquete.')
    }
    if (manifestEntry.size > (options.limits?.maxManifestBytes ?? DEFAULT_ZIP_LIMITS.maxManifestBytes)) {
      throw new AppError('MANIFEST_INVALID', 'manifest.json es demasiado grande.')
    }

    let manifestRaw: Buffer
    try {
      manifestRaw = await archive.readFile('manifest.json', DEFAULT_ZIP_LIMITS.maxManifestBytes)
    } catch (error) {
      throw packageErrorFromZip(error)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(manifestRaw.toString('utf8'))
    } catch (error) {
      throw new AppError('MANIFEST_INVALID', 'manifest.json no es JSON válido.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    const validation = validateManifest(parsed)
    if (!validation.ok) {
      throw new AppError('MANIFEST_INVALID', 'El manifiesto del paquete no es válido.', {
        details: { issues: validation.issues }
      })
    }

    const manifest = validation.manifest
    const setupEntry = archive.find(manifest.installation.executable)
    if (!setupEntry || setupEntry.directory) {
      throw new AppError(
        'PACKAGE_INVALID',
        `El instalador declarado no existe dentro del paquete: ${manifest.installation.executable}`
      )
    }
    if (!setupEntry.normalizedPath.toLowerCase().endsWith('.exe')) {
      validation.warnings.push(
        'El instalador declarado no tiene extensión .exe. El motor lo ejecutará directamente; verifica el tipo.'
      )
    }

    const workingDirectory =
      manifest.installation.workingDirectory ??
      manifest.installation.executable.split('/').slice(0, -1).join('/')
    const workingDirectoryExists = archive.plan.entries.some(
      (entry) =>
        entry.directory &&
        entry.normalizedPath.toLowerCase() === workingDirectory.toLowerCase()
    ) || archive.plan.entries.some((entry) =>
      entry.normalizedPath.toLowerCase().startsWith(workingDirectory.toLowerCase() + '/')
    )
    if (!workingDirectoryExists) {
      throw new AppError(
        'PACKAGE_INVALID',
        `El directorio de trabajo del instalador no existe en payload/: ${workingDirectory}`
      )
    }

    const sha256 = options.skipHash ? '' : await sha256File(absolutePath, options.signal)
    const finalStats = await stat(absolutePath)
    if (finalStats.size !== stats.size || Math.abs(finalStats.mtimeMs - stats.mtimeMs) > 2) {
      throw new AppError(
        'PACKAGE_INVALID',
        'El paquete cambió mientras se validaba. Espera a que termine la copia y vuelve a importarlo.'
      )
    }

    return {
      filePath: absolutePath,
      fileName: path.basename(absolutePath),
      size: stats.size,
      sha256,
      manifest,
      warnings: validation.warnings,
      entryCount: structure.entryCount,
      payloadBytes: structure.payloadBytes,
      payloadFiles: structure.payloadFiles,
      mtimeMs: stats.mtimeMs
    }
  } finally {
    archive.close()
  }
}

export interface CreatePackageOptions {
  manifestPath: string
  payloadDir: string
  outputPath: string
  force?: boolean
  now?: Date
}

export interface CreatedPackage {
  outputPath: string
  size: number
  sha256: string
  entryCount: number
}

interface WalkedFile {
  absolutePath: string
  relativePath: string
  size: number
  mtime: Date
}

async function walkPayload(payloadDir: string): Promise<{ files: WalkedFile[]; directories: string[] }> {
  const files: WalkedFile[] = []
  const directories: string[] = []

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const checked = checkRelativePath(relativePath, { label: `La ruta ${relativePath}` })
      if (!checked.ok) throw new AppError('PACKAGE_INVALID', checked.reason)
      const absolutePath = path.join(current, entry.name)
      const stats = await lstat(absolutePath)
      if (stats.isSymbolicLink()) {
        throw new AppError(
          'PACKAGE_INVALID',
          `No se permiten enlaces simbólicos en payload: ${relativePath}`
        )
      }
      if (stats.isDirectory()) {
        directories.push(relativePath)
        await walk(absolutePath, relativePath)
      } else if (stats.isFile()) {
        files.push({
          absolutePath,
          relativePath,
          size: stats.size,
          mtime: stats.mtime
        })
      } else {
        throw new AppError(
          'PACKAGE_INVALID',
          `payload contiene una entrada especial no admitida: ${relativePath}`
        )
      }
    }
  }

  const stats = await lstat(payloadDir).catch((error) => {
    throw new AppError('PACKAGE_INVALID', 'No se encontró la carpeta payload.', { cause: error })
  })
  if (!stats.isDirectory()) {
    throw new AppError('PACKAGE_INVALID', 'La ruta de payload no es un directorio.')
  }
  await walk(payloadDir, '')
  return { files, directories }
}

export async function createPackage(options: CreatePackageOptions): Promise<CreatedPackage> {
  const manifestPath = path.resolve(options.manifestPath)
  const payloadDir = path.resolve(options.payloadDir)
  const outputPath = path.resolve(options.outputPath)

  if (isPathInside(payloadDir, outputPath)) {
    throw new AppError('VALIDATION_ERROR', 'El .game de salida no puede escribirse dentro de payload/.')
  }

  if (!options.force) {
    try {
      await access(outputPath)
      throw new AppError('VALIDATION_ERROR', `El archivo de salida ya existe: ${outputPath}`)
    } catch (error) {
      if (isAppError(error)) throw error
      // ENOENT es el caso esperado.
    }
  }

  let manifestRaw: string
  try {
    manifestRaw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw new AppError('MANIFEST_INVALID', `No se pudo leer el manifiesto: ${manifestPath}`, {
      cause: error
    })
  }
  if (Buffer.byteLength(manifestRaw, 'utf8') > DEFAULT_ZIP_LIMITS.maxManifestBytes) {
    throw new AppError('MANIFEST_INVALID', 'El manifiesto es demasiado grande.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestRaw)
  } catch (error) {
    throw new AppError('MANIFEST_INVALID', 'El manifiesto no es JSON válido.', {
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  const validation = validateManifest(parsed)
  if (!validation.ok) {
    throw new AppError('MANIFEST_INVALID', 'El manifiesto no es válido.', {
      details: { issues: validation.issues }
    })
  }
  const manifest = validation.manifest

  const payload = await walkPayload(payloadDir)
  const setupRelative = manifest.installation.executable.replace(/^payload\//, '')
  const setupPath = path.resolve(payloadDir, ...setupRelative.split('/'))
  if (!isPathInside(payloadDir, setupPath)) {
    throw new AppError('MANIFEST_INVALID', 'El instalador apunta fuera de payload/.')
  }
  const setupStats = await lstat(setupPath).catch(() => null)
  if (!setupStats?.isFile()) {
    throw new AppError(
      'PACKAGE_INVALID',
      `No existe el instalador declarado en payload: ${setupRelative}`
    )
  }

  const workDirRelative =
    (manifest.installation.workingDirectory ?? manifest.installation.executable.split('/').slice(0, -1).join('/'))
      .replace(/^payload\/?/, '')
  if (workDirRelative) {
    const workDirPath = path.resolve(payloadDir, ...workDirRelative.split('/'))
    const workDirStats = await lstat(workDirPath).catch(() => null)
    if (!workDirStats?.isDirectory()) {
      throw new AppError(
        'PACKAGE_INVALID',
        `No existe el directorio de trabajo declarado en payload: ${workDirRelative}`
      )
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  const zip = new yazl.ZipFile()
  const fixedDate = options.now ?? new Date('2024-01-01T00:00:00Z')

  for (const directory of payload.directories) {
    zip.addEmptyDirectory(`payload/${directory}`, { mtime: fixedDate })
  }
  for (const file of payload.files) {
    zip.addFile(file.absolutePath, `payload/${file.relativePath}`, {
      mtime: file.mtime,
      mode: 0o644
    })
  }
  zip.addBuffer(
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    'manifest.json',
    { mtime: fixedDate, mode: 0o644 }
  )

  try {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(tempPath, { flags: 'wx' })
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        output.destroy()
        reject(error)
      }
      output.on('error', fail)
      output.on('close', () => {
        if (settled) return
        settled = true
        resolve()
      })
      zip.outputStream.on('error', fail)
      zip.outputStream.pipe(output)
      zip.end()
    })

    if (!options.force) {
      try {
        await access(outputPath)
        throw new AppError('VALIDATION_ERROR', `El archivo de salida ya existe: ${outputPath}`)
      } catch (error) {
        if (isAppError(error)) throw error
      }
    }
    await rm(outputPath, { force: true })
    await rename(tempPath, outputPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (isAppError(error)) throw error
    throw new AppError('IO_ERROR', 'No se pudo crear el paquete .game.', {
      cause: error instanceof Error ? error.message : String(error)
    })
  }

  const outputStats = await stat(outputPath)
  const sha256 = await sha256File(outputPath)
  return {
    outputPath,
    size: outputStats.size,
    sha256,
    entryCount: payload.files.length + payload.directories.length + 1
  }
}

export function summarizeManifest(manifest: Manifest): Record<string, unknown> {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    profile: manifest.installation.profile,
    setup: manifest.installation.executable,
    launch: manifest.launch.executable,
    steam: manifest.steam.enabled,
    verification: manifest.installation.verification.requiredFiles
  }
}

export function formatManifestIssues(issues: ManifestIssue[]): string {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')
}

/** Reexportado para utilidades de escaneo sin acoplar el CLI al resto del core. */
export function comparePackageVersions(a: string, b: string): number {
  return compareVersions(a, b)
}
