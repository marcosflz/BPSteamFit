import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractZip } from '../../src/core/package/zip'
import { demoPackagePath } from '../helpers/demo'
import { makeTempDir } from '../helpers/temp'
import { makeRawZip } from '../helpers/zip-writer'

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

describe('extracción segura', () => {
  it('extrae el paquete demo preservando payload y manifiesto', async () => {
    const temp = await makeTempDir('bpsfit-extract-')
    try {
      const destination = path.join(temp.path, 'destino con ñ')
      let progressCalls = 0
      const result = await extractZip(demoPackagePath, {
        destination,
        onProgress: () => {
          progressCalls += 1
        }
      })
      expect(result.extractedFiles).toBeGreaterThanOrEqual(4)
      expect(progressCalls).toBeGreaterThan(0)
      expect(await exists(path.join(destination, 'manifest.json'))).toBe(true)
      expect(await exists(path.join(destination, 'payload', 'setup.exe'))).toBe(true)
      const level = await readFile(path.join(destination, 'payload', 'data', 'payload.bin'))
      expect(level.length).toBe(131072)
      const entries = await readdir(destination)
      expect(entries).not.toContain('..')
    } finally {
      await temp.cleanup()
    }
  })

  it('no escribe fuera del destino con Zip Slip', async () => {
    const temp = await makeTempDir('bpsfit-extract-')
    try {
      const zipPath = path.join(temp.path, 'slip.game')
      const destination = path.join(temp.path, 'destino')
      await writeFile(
        zipPath,
        makeRawZip([
          { name: 'payload/ok.txt', data: Buffer.from('ok') },
          { name: '../escapado.txt', data: Buffer.from('mal') }
        ])
      )
      await expect(
        extractZip(zipPath, { destination })
      ).rejects.toMatchObject({ code: expect.stringMatching(/EXTRACT_|PACKAGE_/) })
      expect(await exists(path.join(temp.path, 'escapado.txt'))).toBe(false)
    } finally {
      await temp.cleanup()
    }
  })

  it('rechaza enlaces simbólicos y entradas cifradas', async () => {
    const temp = await makeTempDir('bpsfit-extract-')
    try {
      const symlinkZip = path.join(temp.path, 'link.game')
      await writeFile(
        symlinkZip,
        makeRawZip([
          {
            name: 'payload/link.txt',
            data: Buffer.from('destino'),
            externalFileAttributes: (0o120777 << 16) >>> 0
          }
        ])
      )
      await expect(
        extractZip(symlinkZip, { destination: path.join(temp.path, 'a') })
      ).rejects.toMatchObject({ code: 'EXTRACT_UNSAFE' })

      const encryptedZip = path.join(temp.path, 'enc.game')
      await writeFile(
        encryptedZip,
        makeRawZip([{ name: 'payload/a.txt', data: Buffer.from('x'), flags: 0x801 }])
      )
      await expect(
        extractZip(encryptedZip, { destination: path.join(temp.path, 'b') })
      ).rejects.toMatchObject({ code: 'EXTRACT_UNSAFE' })
    } finally {
      await temp.cleanup()
    }
  })

  it('respeta la cancelación antes de empezar', async () => {
    const temp = await makeTempDir('bpsfit-extract-')
    try {
      const destination = path.join(temp.path, 'cancelado')
      const controller = new AbortController()
      controller.abort()
      await expect(
        extractZip(demoPackagePath, { destination, signal: controller.signal })
      ).rejects.toMatchObject({ code: 'EXTRACT_CANCELLED' })
      expect(await exists(path.join(destination, 'payload'))).toBe(false)
    } finally {
      await temp.cleanup()
    }
  })

  it('aplica límites configurables de número de entradas', async () => {
    const temp = await makeTempDir('bpsfit-extract-')
    try {
      await expect(
        extractZip(demoPackagePath, {
          destination: path.join(temp.path, 'limitado'),
          limits: { maxEntries: 2 }
        })
      ).rejects.toMatchObject({ code: 'EXTRACT_LIMIT' })
    } finally {
      await temp.cleanup()
    }
  })
})
