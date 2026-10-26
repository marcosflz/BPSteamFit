import { mkdir, readdir, utimes } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanupStaleInstallTemps,
  createAppPaths,
  ensureBaseDirectories
} from '../../src/core/config/app-paths'
import { makeTempDir } from '../helpers/temp'

describe('limpieza de temporales de instalación', () => {
  it('elimina solo temporales gestionados y antiguos', async () => {
    const temp = await makeTempDir('bpsfit-temp-cleanup-')
    try {
      const paths = createAppPaths(path.join(temp.path, 'userdata'))
      await ensureBaseDirectories(paths)
      const oldDir = path.join(paths.temp, 'bpsfit-install-old')
      const freshDir = path.join(paths.temp, 'bpsfit-install-fresh')
      const foreignDir = path.join(paths.temp, 'otra-cosa')
      await mkdir(oldDir, { recursive: true })
      await mkdir(freshDir, { recursive: true })
      await mkdir(foreignDir, { recursive: true })
      const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000)
      await utimes(oldDir, ancient, ancient)
      const removed = await cleanupStaleInstallTemps(paths, 24 * 60 * 60 * 1000)
      expect(removed).toBe(1)
      const remaining = await readdir(paths.temp)
      expect(remaining).not.toContain('bpsfit-install-old')
      expect(remaining).toContain('bpsfit-install-fresh')
      expect(remaining).toContain('otra-cosa')
    } finally {
      await temp.cleanup()
    }
  })
})
