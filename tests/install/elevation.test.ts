import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildWindowsCommandLine, quoteWindowsArgument } from '@shared/windows-args'
import { demoPayloadDir } from '../helpers/demo'
import { makeTempDir } from '../helpers/temp'

const execFileAsync = promisify(execFile)
const helperPath = path.join(process.cwd(), 'resources', 'native', 'bpsfit-elevate.exe')

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('argumentos de Windows', () => {
  it('cita espacios, comillas y barras finales con el algoritmo de CommandLineToArgvW', () => {
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('simple')).toBe('simple')
    expect(quoteWindowsArgument('dos palabras')).toBe('"dos palabras"')
    expect(quoteWindowsArgument('C:\\Juegos\\Mi Juego')).toBe('"C:\\Juegos\\Mi Juego"')
    expect(quoteWindowsArgument('comilla"dentro')).toBe('"comilla\\"dentro"')
    expect(quoteWindowsArgument('barra final\\')).toBe('"barra final\\\\"')
    expect(quoteWindowsArgument('ruta con espacio\\')).toBe('"ruta con espacio\\\\"')
    expect(buildWindowsCommandLine(['/S', '/DIR=C:\\A B'])).toBe('/S "/DIR=C:\\A B"')
  })
})

describe('auxiliar de elevación', () => {
  it('ejecuta el demo con --no-elevate, respeta la línea de comandos y devuelve el código', async () => {
    const temp = await makeTempDir('bpsfit-elevate-')
    try {
      const installDir = path.join(temp.path, 'Juego Demo Ñandú')
      const requestPath = path.join(temp.path, 'request.json')
      const resultPath = path.join(temp.path, 'result.json')
      const logPath = path.join(temp.path, 'helper.log')
      await writeFile(
        requestPath,
        JSON.stringify({
          executable: path.join(demoPayloadDir, 'setup.exe'),
          parameters: buildWindowsCommandLine(['/S', `/DIR=${installDir}`]),
          workingDirectory: demoPayloadDir,
          workRoot: demoPayloadDir,
          resultPath,
          logPath
        }),
        'utf8'
      )
      await execFileAsync(helperPath, ['--no-elevate', '--request', requestPath], {
        timeout: 30_000,
        windowsHide: true
      })
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        ok: boolean
        exitCode: number
      }
      expect(result.ok).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(await exists(path.join(installDir, 'bin', 'ExampleQuest.exe'))).toBe(true)
      expect(await exists(path.join(installDir, 'data', 'level1.dat'))).toBe(true)
      expect(await readFile(logPath, 'utf8')).toContain('Proceso terminado con código 0')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza solicitudes malformadas sin ejecutar nada', async () => {
    const temp = await makeTempDir('bpsfit-elevate-bad-')
    try {
      const requestPath = path.join(temp.path, 'bad.json')
      await writeFile(requestPath, '{no es json', 'utf8')
      await expect(
        execFileAsync(helperPath, ['--no-elevate', '--request', requestPath], {
          timeout: 10_000,
          windowsHide: true
        })
      ).rejects.toMatchObject({ code: 2 })
      await expect(
        execFileAsync(helperPath, ['--no-elevate', '--request', path.join(temp.path, 'missing.json')], {
          timeout: 10_000,
          windowsHide: true
        })
      ).rejects.toMatchObject({ code: 2 })
    } finally {
      await temp.cleanup()
    }
  })
})
