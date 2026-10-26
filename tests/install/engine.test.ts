import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectPackage } from '../../src/core/package/package-service'
import { runInstallation, assertInstallDestination } from '../../src/core/install/engine'
import { buildDemoVariant, demoPackagePath } from '../helpers/demo'
import { makeTempDir } from '../helpers/temp'

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

interface RunOptions {
  packagePath?: string
  expectedSha256?: string
  installDir?: string
  confirmed?: boolean
  signal?: AbortSignal
  tempRoot?: string
  logPath?: string
}

async function runDemo(workDir: string, options: RunOptions = {}) {
  const packagePath = options.packagePath ?? demoPackagePath
  const inspected = await inspectPackage(packagePath)
  const installDir = options.installDir ?? path.join(workDir, 'installs', 'Example Quest')
  return runInstallation({
    packagePath,
    expectedSha256: options.expectedSha256 ?? inspected.sha256,
    installDir,
    tempRoot: options.tempRoot ?? path.join(workDir, 'temp'),
    logPath:
      options.logPath ??
      path.join(workDir, 'logs', `install-${Date.now()}-${Math.random().toString(16).slice(2)}.log`),
    confirmed: options.confirmed ?? true,
    signal: options.signal
  })
}

describe('motor de instalación', () => {
  it('instala el demo, verifica archivos y conserva evidencia de log', async () => {
    const temp = await makeTempDir('bpsfit-install-')
    try {
      const installDir = path.join(temp.path, 'Mis Juegos', 'Example Quest Ñandú')
      const logPath = path.join(temp.path, 'logs', 'instalacion.log')
      const result = await runDemo(temp.path, {
        installDir,
        logPath,
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('installed')
      expect(result.snapshot.verification?.ok).toBe(true)
      expect(result.snapshot.exitCode).toBe(0)
      expect(await fileExists(path.join(installDir, 'bin', 'ExampleQuest.exe'))).toBe(true)
      expect(await fileExists(path.join(installDir, 'data', 'level1.dat'))).toBe(true)
      const log = await readFile(logPath, 'utf8')
      expect(log).toContain('Estado final: installed')
      expect(log).toContain('Verificación correcta')
      expect(log).not.toMatch(/api[_-]?key/i)
    } finally {
      await temp.cleanup()
    }
  })

  it('considera fallo un código de salida inesperado y no exige esperar la verificación completa', async () => {
    const temp = await makeTempDir('bpsfit-install-fail-')
    try {
      const variant = await buildDemoVariant(temp.path, 'fallo', (manifest) => {
        manifest.installation.arguments = ['/S', '/DIR={installDir}', '/FAIL']
      })
      const started = Date.now()
      const result = await runDemo(temp.path, {
        packagePath: variant.packagePath,
        installDir: path.join(temp.path, 'installs', 'Fallo'),
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('failed')
      expect(result.snapshot.exitCode).toBe(3)
      expect(result.snapshot.error?.code).toBe('INSTALL_EXIT_CODE')
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(
        await fileExists(path.join(temp.path, 'installs', 'Fallo', 'bin', 'ExampleQuest.exe'))
      ).toBe(false)
    } finally {
      await temp.cleanup()
    }
  })

  it('espera a procesos secundarios mediante verificación de archivos, no por nombre de proceso', async () => {
    const temp = await makeTempDir('bpsfit-install-helper-')
    try {
      const variant = await buildDemoVariant(temp.path, 'helper', (manifest) => {
        manifest.installation.arguments = ['/S', '/DIR={installDir}', '/HELPER']
        manifest.installation.verification.requiredFiles.push('data/ready.marker')
        manifest.installation.verification.timeoutSeconds = 10
      })
      const installDir = path.join(temp.path, 'installs', 'Helper')
      const result = await runDemo(temp.path, {
        packagePath: variant.packagePath,
        installDir,
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('installed')
      expect(result.snapshot.verification?.ok).toBe(true)
      expect(await fileExists(path.join(installDir, 'data', 'ready.marker'))).toBe(true)
    } finally {
      await temp.cleanup()
    }
  })

  it('distingue reinicio pendiente de fallo', async () => {
    const temp = await makeTempDir('bpsfit-install-reboot-')
    try {
      const variant = await buildDemoVariant(temp.path, 'reboot', (manifest) => {
        manifest.installation.arguments = ['/S', '/DIR={installDir}', '/REBOOT']
        manifest.installation.rebootRequiredExitCodes = [3010]
      })
      const result = await runDemo(temp.path, {
        packagePath: variant.packagePath,
        installDir: path.join(temp.path, 'installs', 'Reboot'),
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('reboot_pending')
      expect(result.snapshot.rebootRequired).toBe(true)
      expect(result.snapshot.exitCode).toBe(3010)
      expect(result.snapshot.verification?.ok).toBe(true)
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza un paquete que cambió desde la importación', async () => {
    const temp = await makeTempDir('bpsfit-install-integrity-')
    try {
      const result = await runDemo(temp.path, {
        expectedSha256: '0'.repeat(64),
        installDir: path.join(temp.path, 'installs', 'Integridad'),
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('failed')
      expect(result.snapshot.error?.code).toBe('PACKAGE_INTEGRITY_MISMATCH')
      expect(await fileExists(path.join(temp.path, 'installs', 'Integridad'))).toBe(false)
    } finally {
      await temp.cleanup()
    }
  })

  it('exige confirmación explícita antes de ejecutar código', async () => {
    const temp = await makeTempDir('bpsfit-install-confirm-')
    try {
      const result = await runDemo(temp.path, {
        confirmed: false,
        installDir: path.join(temp.path, 'installs', 'Sin confirmar'),
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('failed')
      expect(result.snapshot.error?.code).toBe('INSTALL_CONFIRMATION_REQUIRED')
    } finally {
      await temp.cleanup()
    }
  })

  it('no sobrescribe un destino que ya contiene archivos', async () => {
    const temp = await makeTempDir('bpsfit-install-existing-')
    try {
      const installDir = path.join(temp.path, 'installs', 'Existente')
      await mkdir(installDir, { recursive: true })
      await writeFile(path.join(installDir, 'importante.txt'), 'no borrar')
      const result = await runDemo(temp.path, {
        installDir,
        tempRoot: path.join(temp.path, 'temp')
      })
      expect(result.snapshot.state).toBe('failed')
      expect(result.snapshot.error?.code).toBe('INSTALL_DEST_UNSAFE')
      expect(await readFile(path.join(installDir, 'importante.txt'), 'utf8')).toBe('no borrar')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza rutas extendidas, UNC y unidades raíz antes de escribir', async () => {
    const temp = await makeTempDir('bpsfit-install-path-')
    try {
      for (const target of [
        '\\\\?\\C:\\Windows\\Temp\\bpsfit-poc',
        '\\\\server\\share\\juego',
        'C:\\'
      ]) {
        await expect(
          assertInstallDestination(target, path.join(temp.path, 'temp'))
        ).rejects.toMatchObject({ code: 'INSTALL_DEST_UNSAFE' })
      }
    } finally {
      await temp.cleanup()
    }
  })

  it('cancela la validación si la señal ya está abortada', async () => {
    const temp = await makeTempDir('bpsfit-install-cancel-')
    try {
      const controller = new AbortController()
      controller.abort()
      const result = await runDemo(temp.path, {
        installDir: path.join(temp.path, 'installs', 'Cancelado'),
        tempRoot: path.join(temp.path, 'temp'),
        signal: controller.signal
      })
      expect(result.snapshot.state).toBe('cancelled')
      expect(result.snapshot.error?.code).toBe('INSTALL_CANCELLED')
    } finally {
      await temp.cleanup()
    }
  })

  it('no deja la carpeta temporal tras una instalación correcta', async () => {
    const temp = await makeTempDir('bpsfit-install-temp-')
    try {
      const tempRoot = path.join(temp.path, 'temp')
      const result = await runDemo(temp.path, {
        installDir: path.join(temp.path, 'installs', 'Temporal'),
        tempRoot
      })
      expect(result.snapshot.state).toBe('installed')
      const remaining = await import('node:fs/promises').then((fs) => fs.readdir(tempRoot))
      expect(remaining).toEqual([])
    } finally {
      await temp.cleanup()
    }
  })
})
