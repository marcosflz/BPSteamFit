import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { buildWindowsCommandLine } from '@shared/windows-args'

export interface ElevatedSetupOptions {
  helperPath: string
  executable: string
  argumentsList: string[]
  workingDirectory: string
  tempDir: string
  signal?: AbortSignal
}

export interface ElevatedSetupResult {
  exitCode: number
  pid?: number
  helperLogPath: string
}

interface HelperResult {
  ok?: boolean
  canceled?: boolean
  exitCode?: number
  pid?: number
  error?: string
  errorCode?: number
}

/**
 * Ejecuta un setup elevado a través de un auxiliar que usa ShellExecuteEx
 * "runas". UAC pertenece al escritorio seguro: la app solo muestra el aviso y
 * espera; no intenta controlar ese diálogo.
 */
export async function runElevatedSetup(
  options: ElevatedSetupOptions
): Promise<ElevatedSetupResult> {
  const requestDir = path.join(options.tempDir, '.bpsfit-elevation')
  const requestPath = path.join(requestDir, 'request.json')
  const resultPath = path.join(requestDir, 'result.json')
  const helperLogPath = path.join(requestDir, 'helper.log')
  await mkdir(requestDir, { recursive: true })
  await writeFile(
    requestPath,
    JSON.stringify(
      {
        executable: options.executable,
        parameters: buildWindowsCommandLine(options.argumentsList),
        workingDirectory: options.workingDirectory,
        workRoot: options.tempDir,
        resultPath,
        logPath: helperLogPath
      },
      null,
      2
    ),
    { encoding: 'utf8', mode: 0o600 }
  )

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      let child
      try {
        child = spawn(options.helperPath, ['--request', requestPath], {
          shell: false,
          windowsHide: false,
          stdio: ['ignore', 'ignore', 'ignore']
        })
      } catch (error) {
        reject(
          new AppError('INSTALL_ELEVATION_REQUIRED', 'No se pudo iniciar el auxiliar de elevación.', {
            cause: error instanceof Error ? error.message : String(error)
          })
        )
        return
      }
      child.once('error', (error) => {
        reject(
          new AppError('INSTALL_ELEVATION_REQUIRED', 'No se pudo iniciar el auxiliar de elevación.', {
            cause: error.message
          })
        )
      })
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }
  )

  let parsed: HelperResult | null = null
  try {
    parsed = JSON.parse(await readFile(resultPath, 'utf8')) as HelperResult
  } catch {
    parsed = null
  }

  if (!parsed) {
    throw new AppError(
      'INSTALL_ELEVATION_REQUIRED',
      `El auxiliar de elevación no devolvió un resultado (código ${String(exit.code)}). Consulta el log para más detalle.`,
      { details: { helperLogPath } }
    )
  }
  if (parsed.canceled) {
    throw new AppError(
      'INSTALL_ELEVATION_REQUIRED',
      'Se canceló o no se completó la solicitud de UAC. La elevación requiere intervención manual en el escritorio seguro; el mando no puede controlarla.',
      { details: { helperLogPath, errorCode: parsed.errorCode } }
    )
  }
  if (!parsed.ok || typeof parsed.exitCode !== 'number') {
    throw new AppError(
      'INSTALL_PROCESS_FAILED',
      parsed.error ?? 'El auxiliar de elevación no pudo ejecutar el setup.',
      { details: { helperLogPath } }
    )
  }

  return {
    exitCode: parsed.exitCode,
    pid: parsed.pid,
    helperLogPath
  }
}

export async function readHelperLog(helperLogPath: string): Promise<string> {
  try {
    return await readFile(helperLogPath, 'utf8')
  } catch {
    return ''
  }
}
