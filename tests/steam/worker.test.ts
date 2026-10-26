import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectShortcuts,
  readShortcutsFile,
  runSteamSyncWorker,
  type SteamSyncDeps
} from '@core/steam'
import {
  cleanupTempDirectories,
  createTempSteam,
  writeJson
} from './helpers'

afterEach(cleanupTempDirectories)

function workerDeps(close = true): Partial<SteamSyncDeps> {
  let running = true
  let now = 1_700_000_000_000
  return {
    now: () => new Date(now),
    nowMs: () => now,
    sleep: async (ms) => {
      now += ms
    },
    isSteamRunning: async () => running,
    requestSteamShutdown: async () => {
      if (close) running = false
    },
    launchSteamBigPicture: async () => {
      running = true
    }
  }
}

describe('Runner auxiliar (sin Electron)', () => {
  it('lee un JSON de trabajo, escribe estado y devuelve 0', async () => {
    const temp = await createTempSteam()
    const workPath = join(temp.root, 'job.json')
    const statePath = join(temp.root, 'worker-state.json')
    await writeJson(workPath, {
      id: 'worker-1',
      steamRoot: temp.root,
      steamExe: temp.steamExe,
      accountId: temp.accountId,
      desired: [
        {
          gameId: 'hades',
          appName: 'Hades',
          exePath: 'C:\\Games\\Hades\\Hades.exe',
          startDir: 'C:\\Games\\Hades',
          tags: ['Salon']
        }
      ],
      managedRefs: [],
      backupDir: temp.backupDir,
      statePath: 'ignorado-por-argv.json',
      shutdownTimeoutMs: 100,
      shutdownPollIntervalMs: 10
    })
    const result = await runSteamSyncWorker({
      jobPath: workPath,
      statePath,
      deps: workerDeps()
    })
    expect(result.exitCode).toBe(0)
    expect(result.state?.status).toBe('completed')
    expect(result.state?.jobId).toBe('worker-1')
    const onDisk = JSON.parse(await readFile(statePath, 'utf8'))
    expect(onDisk.status).toBe('completed')
    expect(onDisk.job.statePath).toBe(statePath)
    const records = inspectShortcuts((await readShortcutsFile(temp.shortcutsPath)).root).records
    expect(records.filter((record) => record.appName === 'Hades')).toHaveLength(1)
  })

  it('devuelve 2 y estado aborted si Steam no cierra', async () => {
    const temp = await createTempSteam()
    const workPath = join(temp.root, 'job.json')
    const statePath = join(temp.root, 'worker-state.json')
    await writeJson(workPath, {
      id: 'worker-abort',
      steamRoot: temp.root,
      accountId: temp.accountId,
      desired: [],
      backupDir: temp.backupDir,
      statePath,
      shutdownTimeoutMs: 50,
      shutdownPollIntervalMs: 10
    })
    const result = await runSteamSyncWorker({
      jobPath: workPath,
      statePath,
      deps: workerDeps(false)
    })
    expect(result.exitCode).toBe(2)
    expect(result.state?.status).toBe('aborted')
    const onDisk = JSON.parse(await readFile(statePath, 'utf8'))
    expect(onDisk.status).toBe('aborted')
    expect(onDisk.error.code).toBe('STEAM_SHUTDOWN_FAILED')
  })

  it('escribe un estado de fallo si el JSON de trabajo es inválido', async () => {
    const temp = await createTempSteam()
    const workPath = join(temp.root, 'job.json')
    const statePath = join(temp.root, 'worker-state.json')
    await writeJson(workPath, { id: 'sin-campos' })
    const result = await runSteamSyncWorker({
      jobPath: workPath,
      statePath,
      deps: workerDeps()
    })
    expect(result.exitCode).toBe(1)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    const onDisk = JSON.parse(await readFile(statePath, 'utf8'))
    expect(onDisk.status).toBe('failed')
    expect(onDisk.error.code).toBe('VALIDATION_ERROR')
    expect(onDisk.statePath).toBe(statePath)
  })

  it('escribe un estado de fallo si el archivo no es JSON', async () => {
    const temp = await createTempSteam()
    const workPath = join(temp.root, 'job.json')
    const statePath = join(temp.root, 'worker-state.json')
    await writeJson(workPath, 'no es objeto')
    const result = await runSteamSyncWorker({
      jobPath: workPath,
      statePath,
      deps: workerDeps()
    })
    expect(result.exitCode).toBe(1)
    expect(result.error?.code).toBe('VALIDATION_ERROR')

    await writeFile(workPath, '{ esto no es json', 'utf8')
    const second = await runSteamSyncWorker({
      jobPath: workPath,
      statePath,
      deps: workerDeps()
    })
    expect(second.exitCode).toBe(1)
    expect(second.error?.code).toBe('VALIDATION_ERROR')
  })
})
