import { copyFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeShortcutAppId,
  inspectShortcuts,
  readShortcutsFile,
  runSteamSync,
  steamSyncStateToResult,
  type SteamSyncDeps,
  type SteamSyncJob
} from '@core/steam'
import { AppError } from '@shared/errors'
import {
  FIXTURES,
  KODI_APPID,
  cleanupTempDirectories,
  createTempSteam,
  type TempSteam
} from './helpers'

afterEach(cleanupTempDirectories)

interface FakeControls {
  running: boolean
  shutdownCalls: number
  launchCalls: number
  sleepCalls: number
  now: number
}

function fakeDeps(
  controls: FakeControls,
  options: {
    closeOnShutdown?: boolean
    launchError?: unknown
    isRunningOverride?: () => Promise<boolean>
    writeError?: unknown
    artworkError?: unknown
  } = {}
): Partial<SteamSyncDeps> {
  return {
    now: () => new Date(controls.now),
    nowMs: () => controls.now,
    sleep: async (ms) => {
      controls.sleepCalls += 1
      controls.now += ms
    },
    isSteamRunning: options.isRunningOverride ?? (async () => controls.running),
    requestSteamShutdown: async () => {
      controls.shutdownCalls += 1
      if (options.closeOnShutdown ?? true) controls.running = false
    },
    launchSteamBigPicture: async () => {
      controls.launchCalls += 1
      if (options.launchError) throw options.launchError
      controls.running = true
    },
    ...(options.writeError
      ? {
          writeShortcutsAtomic: async () => {
            throw options.writeError
          }
        }
      : {}),
    ...(options.artworkError
      ? {
          applyArtwork: async () => {
            throw options.artworkError
          }
        }
      : {})
  }
}

function hadesDesired() {
  return {
    gameId: 'hades',
    appName: 'Hades',
    exePath: 'C:\\Games\\Hades\\Hades.exe',
    startDir: 'C:\\Games\\Hades',
    tags: ['Salon']
  }
}

function makeJob(temp: TempSteam, overrides: Partial<SteamSyncJob> = {}): SteamSyncJob {
  return {
    id: 'sync-1',
    requestedAt: '2026-10-26T10:00:00.000Z',
    steamRoot: temp.root,
    steamExe: temp.steamExe,
    accountId: temp.accountId,
    desired: [hadesDesired()],
    managedRefs: [],
    backupDir: temp.backupDir,
    statePath: temp.statePath,
    shutdownTimeoutMs: 100,
    shutdownPollIntervalMs: 10,
    ...overrides
  }
}

function controls(): FakeControls {
  return {
    running: true,
    shutdownCalls: 0,
    launchCalls: 0,
    sleepCalls: 0,
    now: 1_700_000_000_000
  }
}

describe('Orquestador de sincronización con Steam cerrado', () => {
  it('cierra, hace backup, aplica, reabre en Big Picture y escribe estado', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const c = controls()
    const state = await runSteamSync(makeJob(temp), { deps: fakeDeps(c) })

    expect(state.status).toBe('completed')
    expect(state.steamWasRunning).toBe(true)
    expect(state.steamClosed).toBe(true)
    expect(state.steamRestarted).toBe(true)
    expect(c.shutdownCalls).toBe(1)
    expect(c.launchCalls).toBe(1)
    expect(state.appliedGameIds).toEqual(['hades'])
    expect(state.managedAppIds.hades).toBe(
      computeShortcutAppId('C:\\Games\\Hades\\Hades.exe', 'Hades')
    )
    expect(state.backupPath).toBeDefined()
    expect(await readFile(state.backupPath!)).toEqual(original)

    const persisted = await readShortcutsFile(temp.shortcutsPath)
    const records = inspectShortcuts(persisted.root).records
    expect(records).toHaveLength(3)
    expect(records.find((record) => record.appId === KODI_APPID)).toBeDefined()
    expect(records.find((record) => record.appName === 'Hades')).toBeDefined()

    const onDisk = JSON.parse(await readFile(temp.statePath, 'utf8'))
    expect(onDisk).toMatchObject({
      schemaVersion: 1,
      jobId: 'sync-1',
      status: 'completed',
      phase: 'finished',
      steamRestarted: true
    })
    expect(onDisk.job.id).toBe('sync-1')
    expect(onDisk.managedAppIds.hades).toBe(state.managedAppIds.hades)

    const result = steamSyncStateToResult(state)
    expect(result).toMatchObject({
      id: 'sync-1',
      status: 'completed',
      appliedGameIds: ['hades'],
      steamRestarted: true
    })
  })

  it('es idempotente en un segundo sync y no crea otro backup', async () => {
    const temp = await createTempSteam()
    const firstControls = controls()
    const first = await runSteamSync(makeJob(temp), { deps: fakeDeps(firstControls) })
    expect(first.status).toBe('completed')
    const afterFirst = await stat(temp.shortcutsPath)

    const refs = [{ gameId: 'hades', appId: first.managedAppIds.hades! }]
    const secondControls = controls()
    const second = await runSteamSync(
      makeJob(temp, {
        id: 'sync-2',
        managedRefs: refs,
        statePath: join(temp.root, 'state-2.json')
      }),
      { deps: fakeDeps(secondControls) }
    )
    expect(second.status).toBe('completed')
    expect(second.backupPath).toBeUndefined()
    expect(second.appliedGameIds).toEqual([])
    expect(second.steamRestarted).toBe(true)
    const records = inspectShortcuts((await readShortcutsFile(temp.shortcutsPath)).root).records
    expect(records.filter((record) => record.appName === 'Hades')).toHaveLength(1)
    expect((await stat(temp.shortcutsPath)).mtimeMs).toBe(afterFirst.mtimeMs)
  })

  it('aborta sin matar Steam si no se cierra en el timeout', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const c = controls()
    const state = await runSteamSync(makeJob(temp), {
      deps: fakeDeps(c, { closeOnShutdown: false })
    })
    expect(state.status).toBe('aborted')
    expect(state.error?.code).toBe('STEAM_SHUTDOWN_FAILED')
    expect(state.retryable).toBe(true)
    expect(state.steamClosed).toBe(false)
    expect(state.backupPath).toBeUndefined()
    expect(c.shutdownCalls).toBe(1)
    expect(c.launchCalls).toBe(0)
    expect(c.sleepCalls).toBeGreaterThan(0)
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
    expect(JSON.parse(await readFile(temp.statePath, 'utf8')).status).toBe('aborted')
  })

  it('registra el fallo al aplicar y reabre Steam para no dejarlo cerrado', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const c = controls()
    const failure = new AppError('STEAM_SYNC_FAILED', 'fallo simulado', {
      details: { backupPath: join(temp.backupDir, 'fake.bak') }
    })
    const state = await runSteamSync(makeJob(temp), {
      deps: fakeDeps(c, { writeError: failure })
    })
    expect(state.status).toBe('failed')
    expect(state.error?.code).toBe('STEAM_SYNC_FAILED')
    expect(state.backupPath).toBe(join(temp.backupDir, 'fake.bak'))
    expect(state.retryable).toBe(true)
    expect(c.launchCalls).toBe(1)
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
  })

  it('falla tras escribir shortcuts si el artwork falla, conservando backup para reintentar', async () => {
    const temp = await createTempSteam()
    const source = join(temp.root, 'hero.png')
    await copyFile(join(FIXTURES, 'artwork', 'hero.png'), source)
    const c = controls()
    const hadesAppId = computeShortcutAppId(
      'C:\\Games\\Hades\\Hades.exe',
      'Hades'
    )
    const state = await runSteamSync(
      makeJob(temp, {
        artwork: [{ appId: hadesAppId, kind: 'hero', sourcePath: source }]
      }),
      {
        deps: fakeDeps(c, {
          artworkError: new AppError('ARTWORK_INVALID', 'artwork simulado inválido')
        })
      }
    )
    expect(state.status).toBe('failed')
    expect(state.error?.code).toBe('ARTWORK_INVALID')
    expect(state.backupPath).toBeDefined()
    expect(await stat(state.backupPath!)).toBeDefined()
    expect(c.launchCalls).toBe(1)
    const records = inspectShortcuts((await readShortcutsFile(temp.shortcutsPath)).root).records
    expect(records.filter((record) => record.appName === 'Hades')).toHaveLength(1)
  })

  it('rechaza artwork de un AppID que no pertenece a un shortcut gestionado', async () => {
    const temp = await createTempSteam()
    const source = join(temp.root, 'hero.png')
    await copyFile(join(FIXTURES, 'artwork', 'hero.png'), source)
    const original = await readFile(temp.shortcutsPath)
    const c = controls()
    const state = await runSteamSync(
      makeJob(temp, {
        artwork: [{ appId: 1234, kind: 'hero', sourcePath: source }]
      }),
      { deps: fakeDeps(c) }
    )
    expect(state.status).toBe('failed')
    expect(state.error?.code).toBe('ARTWORK_INVALID')
    expect(state.backupPath).toBeUndefined()
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
    expect(c.launchCalls).toBe(1)
  })

  it('marca completed aunque falle la reapertura, sin ocultar el error', async () => {
    const temp = await createTempSteam()
    const c = controls()
    const state = await runSteamSync(makeJob(temp), {
      deps: fakeDeps(c, {
        launchError: new AppError('UNKNOWN', 'no se pudo lanzar')
      })
    })
    expect(state.status).toBe('completed')
    expect(state.steamRestarted).toBe(false)
    expect(state.reopenError?.code).toBe('UNKNOWN')
    expect(state.warnings.some((warning) => warning.includes('reabrir'))).toBe(true)
  })

  it('no cierra ni relanza Steam si ya estaba cerrado (if-closed)', async () => {
    const temp = await createTempSteam()
    const c = controls()
    c.running = false
    const state = await runSteamSync(makeJob(temp), {
      deps: fakeDeps(c, { isRunningOverride: async () => false })
    })
    expect(state.status).toBe('completed')
    expect(state.steamWasRunning).toBe(false)
    expect(c.shutdownCalls).toBe(0)
    expect(c.launchCalls).toBe(0)
  })

  it('con reopen=always abre Big Picture aunque Steam estuviera cerrado', async () => {
    const temp = await createTempSteam()
    const c = controls()
    c.running = false
    const state = await runSteamSync(makeJob(temp, { reopen: 'always' }), {
      deps: fakeDeps(c, { isRunningOverride: async () => c.running })
    })
    expect(state.status).toBe('completed')
    expect(c.shutdownCalls).toBe(0)
    expect(c.launchCalls).toBe(1)
    expect(state.steamRestarted).toBe(true)
  })

  it('valida la cuenta antes de cerrar Steam y deja estado fallido', async () => {
    const temp = await createTempSteam()
    const c = controls()
    const state = await runSteamSync(makeJob(temp, { accountId: '99999' }), {
      deps: fakeDeps(c)
    })
    expect(state.status).toBe('failed')
    expect(state.error?.code).toBe('STEAM_PROFILE_NOT_FOUND')
    expect(c.shutdownCalls).toBe(0)
    expect(c.launchCalls).toBe(0)
    expect(JSON.parse(await readFile(temp.statePath, 'utf8')).error.code).toBe(
      'STEAM_PROFILE_NOT_FOUND'
    )
  })

  it('con dryRun no escribe shortcuts ni artwork', async () => {
    const temp = await createTempSteam()
    const original = await readFile(temp.shortcutsPath)
    const c = controls()
    const state = await runSteamSync(makeJob(temp, { dryRun: true }), { deps: fakeDeps(c) })
    expect(state.status).toBe('completed')
    expect(state.dryRun).toBe(true)
    expect(state.backupPath).toBeUndefined()
    expect(await readFile(temp.shortcutsPath)).toEqual(original)
    expect(c.launchCalls).toBe(1)
  })
})
