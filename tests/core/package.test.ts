import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { inspectPackage } from '../../src/core/package/package-service'
import { makeRawZip } from '../helpers/zip-writer'
import { demoPackagePath, projectRoot } from '../helpers/demo'
import { makeTempDir } from '../helpers/temp'
import { mkdir } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('paquete .game', () => {
  it('inspecciona el paquete demo generado sin extraerlo', async () => {
    const inspected = await inspectPackage(demoPackagePath)
    expect(inspected.manifest.id).toBe('example-quest')
    expect(inspected.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(inspected.payloadFiles).toBeGreaterThanOrEqual(3)
    expect(inspected.entryCount).toBeGreaterThan(0)
    expect(inspected.warnings).toEqual([])
  })

  it('funciona con rutas Unicode y espacios', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const dir = path.join(temp.path, 'carpeta con ñ y espacios')
      const copy = path.join(dir, 'Mi Juego Ñ.game')
      await mkdir(dir, { recursive: true })
      await writeFile(copy, await readFile(demoPackagePath))
      const inspected = await inspectPackage(copy)
      expect(inspected.manifest.id).toBe('example-quest')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza un archivo que no es ZIP', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const bogus = path.join(temp.path, 'falso.game')
      await writeFile(bogus, 'esto no es un zip')
      await expectCode(inspectPackage(bogus), 'PACKAGE_UNREADABLE')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza un ZIP sin manifest.json', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const bogus = path.join(temp.path, 'sin-manifiesto.game')
      await writeFile(
        bogus,
        makeRawZip([{ name: 'payload/setup.exe', data: Buffer.from('MZ') }])
      )
      await expectCode(inspectPackage(bogus), 'PACKAGE_INVALID')
    } finally {
      await temp.cleanup()
    }
  })

  it('bloquea Zip Slip antes de leer el manifiesto', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const bogus = path.join(temp.path, 'zip-slip.game')
      await writeFile(
        bogus,
        makeRawZip([{ name: '../evil.exe', data: Buffer.from('evil') }])
      )
      await expectCode(inspectPackage(bogus), 'PACKAGE_INVALID')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza entradas cifradas y enlaces simbólicos', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const encrypted = path.join(temp.path, 'cifrado.game')
      await writeFile(
        encrypted,
        makeRawZip([
          { name: 'manifest.json', data: Buffer.from('{}'), flags: 0x801 }
        ])
      )
      await expectCode(inspectPackage(encrypted), 'PACKAGE_INVALID')

      const symlink = path.join(temp.path, 'symlink.game')
      await writeFile(
        symlink,
        makeRawZip([
          {
            name: 'manifest.json',
            data: Buffer.from('{}'),
            externalFileAttributes: (0o120777 << 16) >>> 0
          }
        ])
      )
      await expectCode(inspectPackage(symlink), 'PACKAGE_INVALID')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza entradas fuera de manifest.json/payload', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const manifest = JSON.parse(
        await readFile(path.join(projectRoot, 'demo', 'manifest.json'), 'utf8')
      ) as Record<string, unknown>
      const bogus = path.join(temp.path, 'extra.game')
      await writeFile(
        bogus,
        makeRawZip([
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
          { name: 'payload/setup.exe', data: Buffer.from('MZ') },
          { name: 'payload/game/readme.txt', data: Buffer.from('ok') },
          { name: 'extras/otro.txt', data: Buffer.from('no permitido') }
        ])
      )
      await expectCode(inspectPackage(bogus), 'PACKAGE_INVALID')
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza un manifiesto válido que referencia un setup ausente', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const manifest = JSON.parse(
        await readFile(path.join(projectRoot, 'demo', 'manifest.json'), 'utf8')
      ) as Record<string, unknown>
      const bogus = path.join(temp.path, 'sin-setup.game')
      await writeFile(
        bogus,
        makeRawZip([
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
          { name: 'payload/otro.txt', data: Buffer.from('x') }
        ])
      )
      await expectCode(inspectPackage(bogus), 'PACKAGE_INVALID')
    } finally {
      await temp.cleanup()
    }
  })

  it('aplica límites a entradas con tamaños declarados desproporcionados', async () => {
    const temp = await makeTempDir('bpsfit-pkg-')
    try {
      const bomb = path.join(temp.path, 'bomba.game')
      await writeFile(
        bomb,
        makeRawZip([
          {
            name: 'manifest.json',
            data: Buffer.from('{}'),
            declaredUncompressedSize: 1024 * 1024 * 1024,
            compress: true,
            externalFileAttributes: (0o100644 << 16) >>> 0
          }
        ])
      )
      await expectCode(inspectPackage(bomb), 'PACKAGE_INVALID')
    } finally {
      await temp.cleanup()
    }
  })

  it('el CLI valida y crea paquetes', async () => {
    const temp = await makeTempDir('bpsfit-cli-')
    try {
      const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
      await execFileAsync(
        process.execPath,
        [tsxCli, path.join(projectRoot, 'src', 'cli', 'index.ts'), 'validate', demoPackagePath],
        { cwd: projectRoot, timeout: 30_000 }
      )

      const manifestPath = path.join(projectRoot, 'demo', 'manifest.json')
      const output = path.join(temp.path, 'Creado con espacios.game')
      const created = await execFileAsync(
        process.execPath,
        [
          tsxCli,
          path.join(projectRoot, 'src', 'cli', 'index.ts'),
          'create',
          '--manifest',
          manifestPath,
          '--payload',
          path.join(projectRoot, 'demo', 'out', 'payload'),
          '--out',
          output,
          '--json'
        ],
        { cwd: projectRoot, timeout: 30_000 }
      )
      const parsed = JSON.parse(created.stdout) as { ok: boolean; package: { outputPath: string } }
      expect(parsed.ok).toBe(true)
      const inspected = await inspectPackage(output)
      expect(inspected.manifest.id).toBe('example-quest')
    } finally {
      await temp.cleanup()
    }
  })
})
