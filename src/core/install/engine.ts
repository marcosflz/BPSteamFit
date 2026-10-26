import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, rm, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { InstallProgress, InstallSnapshot } from '@shared/domain'
import { AppError, isAppError, serializeError } from '@shared/errors'
import type { Manifest } from '@shared/manifest'
import { isPathInside, validateLocalAbsolutePath } from '@shared/safe-path'
import { inspectPackage, type InspectedPackage } from '../package/package-service'
import { extractZip } from '../package/zip'
import { FileLog } from '../logging/install-log'
import { checkInstallationPresence, verifyInstallation } from './verify'
import { readHelperLog, runElevatedSetup } from './elevation'

const DEFAULT_WORK_MARGIN_BYTES = 32 * 1024 * 1024

export interface InstallEngineRequest {
  packagePath: string
  expectedSha256?: string
  installDir: string
  /** Directorio de trabajo para extracciones temporales; debe pertenecer a la app. */
  tempRoot: string
  logPath: string
  /** La ejecución de código exige confirmación explícita de la UI. */
  confirmed: boolean
  /** Auxiliar compilado que solicita UAC solo para el setup. */
  elevationHelperPath?: string
  /** Rutas de la propia aplicación que nunca pueden ser destino de instalación. */
  protectedPaths?: string[]
  signal?: AbortSignal
  onSnapshot?: (snapshot: InstallSnapshot) => void
  onProgress?: (progress: InstallProgress) => void
}

export interface InstallEngineResult {
  snapshot: InstallSnapshot
  logPath: string
  manifest?: Manifest
  inspectedPackage?: InspectedPackage
}

export function expandInstallArguments(argumentsList: string[], installDir: string): string[] {
  return argumentsList.map((argument) => argument.split('{installDir}').join(installDir))
}

async function nearestExistingDirectory(target: string): Promise<string | null> {
  let current = path.resolve(target)
  for (let index = 0; index < 64; index += 1) {
    try {
      const stats = await lstat(current)
      if (stats.isDirectory()) return current
      current = path.dirname(current)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
    if (path.parse(current).root === current) return current
  }
  return null
}

async function availableBytes(target: string): Promise<number | null> {
  try {
    const existing = await nearestExistingDirectory(target)
    if (!existing) return null
    const stats = await statfs(existing)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

export async function assertInstallDestination(
  installDir: string,
  tempRoot: string,
  protectedPaths: string[] = []
): Promise<string> {
  const shape = validateLocalAbsolutePath(installDir, 'El destino de instalación')
  if (!shape.ok) {
    throw new AppError('INSTALL_DEST_UNSAFE', shape.reason)
  }
  if (!path.isAbsolute(installDir)) {
    throw new AppError('INSTALL_DEST_UNSAFE', 'El destino de instalación debe ser una ruta absoluta.')
  }
  if (/[\u0000-\u001f]/.test(installDir)) {
    throw new AppError('INSTALL_DEST_UNSAFE', 'El destino contiene caracteres de control.')
  }
  const resolved = path.resolve(installDir)
  if (path.parse(resolved).root === resolved) {
    throw new AppError('INSTALL_DEST_UNSAFE', 'No se puede instalar directamente en la raíz de una unidad.')
  }
  const windowsDir = process.env.WINDIR
  if (windowsDir && isPathInside(windowsDir, resolved)) {
    throw new AppError('INSTALL_DEST_UNSAFE', 'No se puede instalar dentro de la carpeta de Windows.')
  }
  const resolvedTemp = path.resolve(tempRoot)
  if (isPathInside(resolvedTemp, resolved) || isPathInside(resolved, resolvedTemp)) {
    throw new AppError(
      'INSTALL_DEST_UNSAFE',
      'El destino y la carpeta temporal de la aplicación no pueden estar uno dentro del otro.'
    )
  }
  for (const protectedPath of protectedPaths) {
    if (isPathInside(path.resolve(protectedPath), resolved)) {
      throw new AppError(
        'INSTALL_DEST_UNSAFE',
        'El destino elegido está dentro de una carpeta protegida de la aplicación.'
      )
    }
  }

  try {
    const stats = await lstat(resolved)
    if (!stats.isDirectory()) {
      throw new AppError('INSTALL_DEST_UNSAFE', 'El destino existe y no es un directorio.')
    }
    if (stats.isSymbolicLink()) {
      throw new AppError('INSTALL_DEST_UNSAFE', 'El destino es un enlace simbólico; elige otra carpeta.')
    }
    const entries = await readdir(resolved)
    if (entries.length > 0) {
      throw new AppError(
        'INSTALL_DEST_UNSAFE',
        'El destino ya contiene archivos. Esta versión no sobrescribe instalaciones existentes; elige una carpeta vacía o nueva.'
      )
    }
  } catch (error) {
    if (isAppError(error)) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new AppError('INSTALL_DEST_UNSAFE', 'No se pudo comprobar el destino de instalación.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return resolved
}

export interface LaunchCommand {
  executable: string
  arguments: string[]
  workingDirectory: string
}

export async function buildLaunchCommand(
  manifest: Manifest,
  installDir: string
): Promise<LaunchCommand> {
  const base = path.resolve(installDir)
  const executable = path.resolve(base, ...manifest.launch.executable.split('/'))
  if (!isPathInside(base, executable)) {
    throw new AppError('INSTALL_INVALID_STATE', 'El ejecutable de lanzamiento escapa del destino.')
  }
  const workRelative =
    manifest.launch.workingDirectory ?? manifest.launch.executable.split('/').slice(0, -1).join('/')
  const workingDirectory = workRelative
    ? path.resolve(base, ...workRelative.split('/'))
    : base
  if (!isPathInside(base, workingDirectory)) {
    throw new AppError('INSTALL_INVALID_STATE', 'El directorio de lanzamiento escapa del destino.')
  }
  const executableStats = await lstat(executable).catch(() => null)
  if (!executableStats?.isFile() || executableStats.isSymbolicLink()) {
    throw new AppError(
      'INSTALL_INVALID_STATE',
      'No se encuentra el ejecutable del juego instalado o no es un archivo regular.'
    )
  }
  const workStats = await lstat(workingDirectory).catch(() => null)
  if (!workStats?.isDirectory()) {
    throw new AppError('INSTALL_INVALID_STATE', 'No se encuentra el directorio de trabajo del juego.')
  }

  return {
    executable,
    arguments: expandInstallArguments(manifest.launch.arguments, base),
    workingDirectory
  }
}

function terminalState(state: InstallSnapshot['state']): boolean {
  return ['installed', 'reboot_pending', 'failed', 'cancelled', 'interrupted'].includes(state)
}

/**
 * Motor de instalación independiente de la interfaz y de la base de datos.
 * Devuelve un snapshot final; el servicio que lo invoca es responsable de
 * persistir cada transición y de detectar interrupciones al arrancar.
 */
export async function runInstallation(request: InstallEngineRequest): Promise<InstallEngineResult> {
  const startedAt = new Date().toISOString()
  let snapshot: InstallSnapshot = {
    state: 'validating',
    installDir: path.resolve(request.installDir),
    startedAt,
    updatedAt: startedAt,
    logPath: request.logPath,
    progress: { phase: 'Validando paquete y destino', indeterminate: true }
  }
  let log: FileLog | null = null
  let tempDir: string | null = null
  let inspected: InspectedPackage | undefined

  const emit = (patch: Partial<InstallSnapshot> = {}): void => {
    snapshot = {
      ...snapshot,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    request.onSnapshot?.({ ...snapshot })
    if (patch.progress) request.onProgress?.({ ...patch.progress })
  }

  const finish = async (
    state: InstallSnapshot['state'],
    patch: Partial<InstallSnapshot> = {}
  ): Promise<InstallEngineResult> => {
    emit({
      ...patch,
      state,
      finishedAt: new Date().toISOString(),
      progress: undefined
    })
    log?.write(state === 'installed' ? 'info' : 'error', `Estado final: ${state}`)
    if (tempDir) {
      const keep =
        process.env.BPSFIT_KEEP_TEMP === '1' ||
        (state === 'failed' && process.env.BPSFIT_KEEP_FAILED_TEMP === '1')
      if (!keep) {
        const resolvedTempRoot = path.resolve(request.tempRoot)
        if (isPathInside(resolvedTempRoot, tempDir) && path.basename(tempDir).startsWith('bpsfit-install-')) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
          log?.write('info', 'Carpeta temporal de extracción eliminada.')
        }
      } else {
        log?.write('warn', `Carpeta temporal conservada para diagnóstico: ${tempDir}`)
      }
    }
    await log?.close()
    return { snapshot, logPath: request.logPath, manifest: inspected?.manifest, inspectedPackage: inspected }
  }

  try {
    log = await FileLog.create(request.logPath)
    log.info(`Instalación solicitada: ${request.packagePath} -> ${snapshot.installDir}`)
    log.info(`Confirmación de ejecución: ${request.confirmed ? 'sí' : 'no'}`)
    request.onSnapshot?.({ ...snapshot })

    if (!request.confirmed) {
      throw new AppError(
        'INSTALL_CONFIRMATION_REQUIRED',
        'La ejecución del instalador requiere confirmación explícita.'
      )
    }
    if (request.signal?.aborted) {
      throw new AppError('INSTALL_CANCELLED', 'Validación cancelada por el usuario.')
    }

    inspected = await inspectPackage(request.packagePath, { signal: request.signal })
    if (request.signal?.aborted) {
      throw new AppError('INSTALL_CANCELLED', 'Validación cancelada por el usuario.')
    }
    for (const warning of inspected.warnings) log.write('warn', warning)

    if (request.expectedSha256 && inspected.sha256 !== request.expectedSha256) {
      throw new AppError(
        'PACKAGE_INTEGRITY_MISMATCH',
        'El paquete cambió desde que se importó. Actualiza el catálogo y vuelve a intentarlo.',
        {
          details: {
            expectedSha256: request.expectedSha256,
            actualSha256: inspected.sha256
          }
        }
      )
    }

    const installDir = await assertInstallDestination(
      request.installDir,
      request.tempRoot,
      request.protectedPaths
    )
    log.info(`Destino comprobado: ${installDir}`)
    emit({ installDir })

    const tempFree = await availableBytes(request.tempRoot)
    if (tempFree !== null) {
      const required = inspected.payloadBytes + DEFAULT_WORK_MARGIN_BYTES
      log.info(`Espacio libre temporal: ${(tempFree / 1024 / 1024).toFixed(1)} MiB; estimado requerido: ${(required / 1024 / 1024).toFixed(1)} MiB`)
      if (tempFree < required) {
        throw new AppError(
          'INSTALL_NOT_ENOUGH_SPACE',
          'No hay espacio libre suficiente para extraer el paquete con un margen de trabajo.',
          { details: { availableBytes: tempFree, requiredBytes: required } }
        )
      }
    } else {
      log.warn('No se pudo consultar el espacio libre de la carpeta temporal.')
    }
    const targetFree = await availableBytes(installDir)
    if (targetFree !== null) {
      log.info(`Espacio libre en el volumen de destino: ${(targetFree / 1024 / 1024).toFixed(1)} MiB (el instalador puede necesitar más que el payload).`)
    }

    await mkdir(path.resolve(request.tempRoot), { recursive: true })
    tempDir = await mkdtemp(path.join(path.resolve(request.tempRoot), 'bpsfit-install-'))
    log.info(`Extracción temporal: ${tempDir}`)

    emit({
      state: 'extracting',
      progress: {
        phase: 'Extrayendo el payload del paquete',
        bytesDone: 0,
        bytesTotal: inspected.payloadBytes,
        percent: 0,
        indeterminate: false
      }
    })

    await extractZip(request.packagePath, {
      destination: tempDir,
      signal: request.signal,
      onProgress: (completed, total) => {
        const safeTotal = total > 0 ? total : inspected?.payloadBytes ?? 0
        const progress: InstallProgress = {
          phase: 'Extrayendo el payload del paquete',
          bytesDone: completed,
          bytesTotal: safeTotal,
          percent: safeTotal > 0 ? Math.min(100, (completed / safeTotal) * 100) : undefined,
          indeterminate: safeTotal <= 0
        }
        emit({ progress })
      }
    })
    log.info(`Extracción completada (${inspected.payloadBytes} bytes de payload declarado).`)
    if (request.signal?.aborted) {
      throw new AppError('INSTALL_CANCELLED', 'Extracción cancelada por el usuario.')
    }

    const setupPath = path.resolve(tempDir, ...inspected.manifest.installation.executable.split('/'))
    if (!isPathInside(tempDir, setupPath)) {
      throw new AppError('EXTRACT_UNSAFE', 'El ejecutable del instalador escapó de la carpeta temporal.')
    }
    const setupStats = await lstat(setupPath).catch(() => null)
    if (!setupStats?.isFile() || setupStats.isSymbolicLink()) {
      throw new AppError('PACKAGE_INVALID', 'El setup extraído no existe o no es un archivo regular.')
    }
    const workingDirectory = path.resolve(
      tempDir,
      ...(
        inspected.manifest.installation.workingDirectory ??
        inspected.manifest.installation.executable.split('/').slice(0, -1).join('/')
      ).split('/')
    )
    if (!isPathInside(tempDir, workingDirectory)) {
      throw new AppError('EXTRACT_UNSAFE', 'El directorio de trabajo del setup escapó de la carpeta temporal.')
    }
    if (!(await lstat(workingDirectory).catch(() => null))?.isDirectory()) {
      throw new AppError('PACKAGE_INVALID', 'El directorio de trabajo del setup no existe tras la extracción.')
    }

    if (inspected.manifest.installation.requiresElevation && !request.elevationHelperPath) {
      log.warn('El paquete requiere elevación y no hay auxiliar configurado.')
    }

    const args = expandInstallArguments(
      inspected.manifest.installation.arguments,
      installDir
    )
    log.info(`Ejecutando setup: ${setupPath}`)
    log.info(`Argumentos (${args.length}): ${args.join(' ')}`)
    log.info(`Directorio de trabajo: ${workingDirectory}`)

    const requiresElevation = inspected.manifest.installation.requiresElevation
    emit({
      state: 'installing',
      progress: {
        phase: requiresElevation
          ? 'Esperando elevación de Windows. UAC requiere intervención manual; el mando no controla el escritorio seguro.'
          : 'Setup en ejecución. Windows puede mostrar ventanas del instalador.',
        indeterminate: true
      }
    })

    let exit: { code: number | null; signal: NodeJS.Signals | null }
    if (requiresElevation) {
      if (!request.elevationHelperPath) {
        throw new AppError(
          'INSTALL_ELEVATION_REQUIRED',
          'El paquete requiere elevación, pero el auxiliar de UAC no está disponible en esta instalación. Ejecuta el setup manualmente y usa "Comprobar instalación".',
          { details: { setupPath } }
        )
      }
      log.info('Solicitando elevación mediante el auxiliar aislado (UAC). Intervención manual requerida.')
      const elevated = await runElevatedSetup({
        helperPath: request.elevationHelperPath,
        executable: setupPath,
        argumentsList: args,
        workingDirectory,
        tempDir,
        signal: request.signal
      })
      const helperLog = await readHelperLog(elevated.helperLogPath)
      for (const line of helperLog.split(/\r?\n/)) {
        if (line.trim()) log.info(`[elevación] ${line}`)
      }
      exit = { code: elevated.exitCode, signal: null }
      if (elevated.pid) log.info(`El auxiliar reportó PID del setup elevado: ${elevated.pid}.`)
    } else {
      let child: ChildProcess
      try {
        child = spawn(setupPath, args, {
          cwd: workingDirectory,
          shell: false,
          windowsHide: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        throw new AppError('INSTALL_PROCESS_FAILED', 'No se pudo iniciar el proceso del instalador.', {
          cause: error instanceof Error ? error.message : String(error)
        })
      }

      if (child.pid) {
        emit({ pid: child.pid })
        log.info(`Proceso del setup iniciado con PID ${child.pid}.`)
      }
      child.stdout?.on('data', (chunk: Buffer) => log?.writeProcessOutput('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => log?.writeProcessOutput('stderr', chunk))

      exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', (error) => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EACCES' || code === 'EPERM') {
              reject(
                new AppError(
                  'INSTALL_ELEVATION_REQUIRED',
                  'Windows bloqueó el inicio del setup. Puede requerir permisos de administrador; ejecútalo manualmente y vuelve a comprobar la instalación.'
                )
              )
            } else {
              reject(
                new AppError('INSTALL_PROCESS_FAILED', 'El proceso del instalador no pudo ejecutarse.', {
                  cause: error.message
                })
              )
            }
          })
          child.once('exit', (code, signal) => resolve({ code, signal }))
        }
      )
    }

    log.info(`El proceso del setup terminó con código ${String(exit.code)} (señal: ${String(exit.signal)}).`)
    emit({
      exitCode: exit.code ?? undefined,
      state: 'verifying',
      progress: {
        phase: 'Verificando la instalación (los instaladores pueden lanzar procesos secundarios)',
        indeterminate: true
      }
    })

    const verification = await verifyInstallation(installDir, inspected.manifest, {
      timeoutMs:
        exit.code !== null &&
        !inspected.manifest.installation.successExitCodes.includes(exit.code) &&
        !inspected.manifest.installation.rebootRequiredExitCodes.includes(exit.code)
          ? 0
          : inspected.manifest.installation.verification.timeoutSeconds * 1000,
      onProgress: (progress) => emit({ progress })
    })
    log.info(
      verification.ok
        ? 'Verificación correcta.'
        : `Verificación incompleta. Faltan archivos: ${verification.missingFiles.join(', ') || 'ninguno'}; directorios: ${verification.missingDirectories.join(', ') || 'ninguno'}.`
    )

    const rebootRequested =
      exit.code !== null &&
      inspected.manifest.installation.rebootRequiredExitCodes.includes(exit.code)

    if (rebootRequested) {
      log.warn('El instalador pidió un reinicio. No se reinicia Windows automáticamente.')
      return await finish('reboot_pending', {
        exitCode: exit.code ?? undefined,
        rebootRequired: true,
        verification,
        error: verification.ok
          ? undefined
          : {
              code: 'INSTALL_VERIFY_FAILED',
              message:
                'El instalador pidió reiniciar y la verificación aún no está completa. Reinicia Windows y usa "Comprobar instalación".'
            }
      })
    }

    if (exit.code === null) {
      return await finish('failed', {
        error: {
          code: 'INSTALL_PROCESS_FAILED',
          message: 'El setup terminó sin un código de salida utilizable.'
        },
        verification
      })
    }

    if (!inspected.manifest.installation.successExitCodes.includes(exit.code)) {
      return await finish('failed', {
        exitCode: exit.code,
        verification,
        error: {
          code: 'INSTALL_EXIT_CODE',
          message: `El instalador terminó con un código inesperado (${exit.code}). La instalación no se considera correcta.`,
          details: { exitCode: exit.code }
        }
      })
    }

    if (!verification.ok) {
      return await finish('failed', {
        exitCode: exit.code,
        verification,
        error: {
          code: 'INSTALL_VERIFY_FAILED',
          message: 'El instalador terminó, pero no se encontraron todos los archivos de verificación. La instalación no se considera correcta.',
          details: {
            missingFiles: verification.missingFiles,
            missingDirectories: verification.missingDirectories
          }
        }
      })
    }

    return await finish('installed', {
      exitCode: exit.code,
      rebootRequired: false,
      verification
    })
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : new AppError('UNKNOWN', 'La instalación falló.', {
          cause: error instanceof Error ? error.message : String(error)
        })
    log?.write('error', `ERROR [${appError.code}] ${appError.message}`)
    const cancelled =
      appError.code === 'INSTALL_CANCELLED' ||
      appError.code === 'EXTRACT_CANCELLED' ||
      request.signal?.aborted === true
    return await finish(cancelled ? 'cancelled' : 'failed', {
      error: serializeError(
        cancelled && appError.code !== 'INSTALL_CANCELLED'
          ? new AppError('INSTALL_CANCELLED', 'Operación cancelada por el usuario.')
          : appError
      ),
      verification: undefined
    })
  }
}

export async function revalidateInstalledGame(
  manifest: Manifest,
  installDir: string
): Promise<InstallSnapshot> {
  const presence = await checkInstallationPresence(installDir, manifest)
  const now = new Date().toISOString()
  return {
    state: presence.ok ? 'installed' : 'failed',
    installDir,
    verification: {
      ok: presence.ok,
      checkedAt: now,
      missingFiles: presence.missingFiles,
      missingDirectories: presence.missingDirectories
    },
    error: presence.ok
      ? undefined
      : {
          code: 'INSTALL_VERIFY_FAILED',
          message: 'La instalación ya no contiene todos los archivos requeridos.',
          details: {
            missingFiles: presence.missingFiles,
            missingDirectories: presence.missingDirectories,
            invalid: presence.invalid
          }
        },
    updatedAt: now
  }
}

export function isInstallTerminal(state: InstallSnapshot['state']): boolean {
  return terminalState(state)
}
