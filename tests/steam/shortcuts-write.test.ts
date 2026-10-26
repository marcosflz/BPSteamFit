import { readFile, readdir, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyShortcutPlan,
  createEmptyShortcutsRoot,
  createTimestampedBackup,
  inspectShortcuts,
  planShortcutChanges,
  readShortcutsFile,
  serializeShortcutsVdf,
  writeAccountShortcutsAtomic,
  writeShortcutsAtomic,
  type ManagedShortcutRef,
  type ShortcutDesired
} from '@core/steam'
import { AppError } from '@shared/errors'
import { KODI_APPID, cleanupTempDirectories, createTempSteam } from './helpers'

afterEach(cleanupTempDirectories)

const KODI_REF: ManagedShortcutRef = { gameId: 'kodi', appId: KODI_APPID }

function desired(): ShortcutDesired {
  return {
    gameId: 'kodi',
    appName: 'Kodi 2',
    exePath: 'C:\\Games\\Kodi\\kodi.exe',
    startDir: 'C:\\Games\\Kodi',
    tags: ['Salon']
  }
}

async function preparedPlan(shortcutsPath: string) {
  const snapshot = await readShortcutsFile(shortcutsPath)
  const plan = planShortcutChanges(snapshot.root, [desired()], [KODI_REF])
  const applied = applyShortcutPlan(snapshot.root, plan)
  return { snapshot, plan, applied }
}

describe('Escritura atómica y backup de shortcuts.vdf', () => {
  it('hace backup con timestamp, escribe, valida y no toca las entradas ajenas', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const { snapshot, applied } = await preparedPlan(temp.shortcutsPath)
    const result = await writeShortcutsAtomic(temp.shortcutsPath, applied.root, {
      backupDir: temp.backupDir,
      expectedSha256: snapshot.sha256 ?? null,
      now: () => new Date('2026-10-26T12:34:56.789Z'),
      randomSuffix: () => 'deadbeef'
    })
    expect(result.created).toBe(false)
    expect(result.backup?.backupPath).toBeDefined()
    expect(result.backup?.backupPath).toContain('2026-10-26T12-34-56-789Z')
    expect(await readFile(result.backup!.backupPath!)).toEqual(original)
    const persisted = await readShortcutsFile(temp.shortcutsPath)
    expect(persisted.root).toBeDefined()
    expect(inspectShortcuts(persisted.root).records).toHaveLength(2)
    expect(persisted.sha256).toBe(result.sha256)
    const files = await readdir(temp.accountConfigDir)
    expect(files.some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it('crea shortcuts.vdf si no existía, sin backup', async () => {
    const temp = await createTempSteam({ withShortcuts: false })
    const plan = planShortcutChanges(createEmptyShortcutsRoot(), [desired()], [])
    const applied = applyShortcutPlan(createEmptyShortcutsRoot(), plan)
    const result = await writeAccountShortcutsAtomic(temp.root, temp.accountId, applied.root, {
      backupDir: temp.backupDir
    })
    expect(result.created).toBe(true)
    expect(result.backup).toBeUndefined()
    const persisted = await readShortcutsFile(temp.shortcutsPath)
    expect(inspectShortcuts(persisted.root).records).toHaveLength(1)
  })

  it('rechaza sobrescribir si el hash esperado no coincide', async () => {
    const temp = await createTempSteam()
    const { snapshot, applied } = await preparedPlan(temp.shortcutsPath)
    const different = serializeShortcutsVdf(createEmptyShortcutsRoot())
    await writeFile(temp.shortcutsPath, different)
    await expect(
      writeShortcutsAtomic(temp.shortcutsPath, applied.root, {
        backupDir: temp.backupDir,
        expectedSha256: snapshot.sha256 ?? null
      })
    ).rejects.toMatchObject({ code: 'STEAM_BUSY' })
    expect(await readFile(temp.shortcutsPath)).toEqual(different)
  })

  it('no escribe nada si falla el backup', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const { applied } = await preparedPlan(temp.shortcutsPath)
    await expect(
      writeShortcutsAtomic(temp.shortcutsPath, applied.root, {
        backupDir: temp.backupDir,
        deps: {
          createBackup: vi.fn(async () => {
            throw new AppError('STEAM_BACKUP_FAILED', 'fallo de backup simulado')
          })
        }
      })
    ).rejects.toMatchObject({ code: 'STEAM_BACKUP_FAILED' })
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
  })

  it('restaura el original si la escritura falla', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const { applied } = await preparedPlan(temp.shortcutsPath)
    let backupPath: string | undefined
    await expect(
      writeShortcutsAtomic(temp.shortcutsPath, applied.root, {
        backupDir: temp.backupDir,
        deps: {
          writeFileAtomic: vi.fn(async () => {
            throw new AppError('IO_ERROR', 'fallo de escritura simulado')
          })
        }
      })
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
    backupPath = (await readdir(temp.backupDir)).find((name) => name.endsWith('.bak'))
    expect(backupPath).toBeDefined()
  })

  it('restaura el original si la validación posterior falla', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const { applied } = await preparedPlan(temp.shortcutsPath)
    await expect(
      writeShortcutsAtomic(temp.shortcutsPath, applied.root, {
        backupDir: temp.backupDir,
        deps: {
          writeFileAtomic: vi.fn(async (path: string) => {
            await writeFile(path, Buffer.from('corrupto simulado'))
            return { path, bytes: 17, sha256: 'no-importa' }
          })
        }
      })
    ).rejects.toMatchObject({ code: 'STEAM_VDF_INVALID' })
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
  })

  it('registra el backup antes de un fallo de validación en el error', async () => {
    const temp = await createTempSteam()
    const { applied } = await preparedPlan(temp.shortcutsPath)
    try {
      await writeShortcutsAtomic(temp.shortcutsPath, applied.root, {
        backupDir: temp.backupDir,
        deps: {
          writeFileAtomic: vi.fn(async (path: string) => {
            await writeFile(path, Buffer.from('corrupto simulado'))
            return { path, bytes: 17, sha256: 'no-importa' }
          })
        }
      })
      throw new Error('debía fallar')
    } catch (error) {
      const details = (error as AppError).details
      expect(details?.backupPath).toMatch(/\.bak$/)
      expect(details?.restored).toBe(true)
    }
  })

  it('createTimestampedBackup no sobrescribe y verifica SHA-256', async () => {
    const temp = await createTempSteam()
    const record = await createTimestampedBackup(temp.shortcutsPath, temp.backupDir, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      randomSuffix: () => 'abc'
    })
    expect(record.existed).toBe(true)
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(record.backupPath!)).toEqual(await readFile(temp.shortcutsPath))
    const second = await createTimestampedBackup(temp.shortcutsPath, temp.backupDir, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      randomSuffix: () => 'abc'
    })
    expect(second.backupPath).not.toBe(record.backupPath)
  })

  it('rechaza accountIds con separadores de ruta', async () => {
    const temp = await createTempSteam()
    const root = createEmptyShortcutsRoot()
    await expect(
      writeAccountShortcutsAtomic(temp.root, '..\\otra', root, { backupDir: temp.backupDir })
    ).rejects.toMatchObject({ code: 'STEAM_PROFILE_NOT_FOUND' })
  })
})
