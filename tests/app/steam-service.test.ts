import { access, mkdir, readFile, writeFile, utimes } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/core/catalog/catalog-service'
import { EnrichmentService } from '../../src/core/catalog/enrichment-service'
import { createAppPaths, ensureBaseDirectories } from '../../src/core/config/app-paths'
import { InstallRepository } from '../../src/core/storage/install-repository'
import { FileLog } from '../../src/core/logging/install-log'
import { FileArtworkStorage } from '../../src/core/storage/artwork-storage'
import { ArtworkRepository } from '../../src/core/storage/artwork-repository'
import { AppDatabase } from '../../src/core/storage/database'
import { SqliteMetadataCache } from '../../src/core/storage/metadata-cache-repository'
import { SettingsRepository } from '../../src/core/storage/settings-repository'
import { SteamRepository } from '../../src/core/storage/steam-repository'
import { parseGame } from '../../src/core/storage/parsers'
import { SteamService } from '../../src/main/steam-service'
import { runSteamSync, type SteamSyncJob } from '../../src/core/steam/sync'
import { readAccountShortcuts, planShortcutChanges, applyShortcutPlan } from '../../src/core/steam/shortcuts'
import { writeShortcutsAtomic } from '../../src/core/steam/shortcuts-write'
import { steamShortcutsPath } from '../../src/core/steam/paths'
import { copyDemoTo } from '../helpers/demo'
import { makeTempDir } from '../helpers/temp'

const cleanups: Array<() => Promise<void>> = []
const databases: AppDatabase[] = []
const logs: FileLog[] = []

afterEach(async () => {
  for (const log of logs.splice(0)) await log.close()
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // cerrada
    }
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness() {
  const temp = await makeTempDir('bpsfit-steam-service-')
  cleanups.push(temp.cleanup)
  const home = path.join(temp.path, 'home')
  const userData = path.join(temp.path, 'appdata')
  const paths = createAppPaths(userData)
  await ensureBaseDirectories(paths)
  const database = AppDatabase.open(':memory:')
  databases.push(database)
  const settings = new SettingsRepository(database, home)
  const log = await FileLog.create(path.join(userData, 'logs', 'steam-service.log'))
  logs.push(log)
  const catalog = new CatalogService({ database, paths, settings, log })
  const artwork = new ArtworkRepository(database)
  const artworkStorage = new FileArtworkStorage(paths.artwork)
  const cache = new SqliteMetadataCache(database)
  const enrichment = new EnrichmentService({
    catalog: catalog.repository,
    artwork,
    artworkStorage,
    cache,
    settings,
    log,
    getSteamGridDbKey: () => null
  })
  const steam = new SteamRepository(database)
  const installs = new InstallRepository(database)
  const packageFolder = settings.get().packageFolders[0] as string
  await mkdir(packageFolder, { recursive: true })
  await copyDemoTo(packageFolder)
  await catalog.scan()
  await enrichment.refresh('example-quest', {
    forceIdentity: true,
    forceDetails: true,
    forceArtwork: true
  })
  const game = catalog.getGame('example-quest')
  if (!game) throw new Error('No se importó el demo')
  const installDir = path.join(temp.path, 'installed', 'Example Quest')
  await mkdir(path.join(installDir, 'bin'), { recursive: true })
  await mkdir(path.join(installDir, 'data'), { recursive: true })
  await writeFile(path.join(installDir, 'bin', 'ExampleQuest.exe'), 'demo')
  await writeFile(path.join(installDir, 'data', 'level1.dat'), 'demo')
  installs.saveSnapshot('example-quest', game.packageKey, {
    state: 'installed',
    installDir,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    verification: {
      ok: true,
      checkedAt: new Date().toISOString(),
      missingFiles: [],
      missingDirectories: []
    }
  })
  const aggregate = catalog.repository.getAggregate('example-quest')
  if (aggregate) {
    const parsed = parseGame(aggregate.game)
    catalog.repository.setSteamGameState('example-quest', {
      ...parsed.steam,
      syncState: 'pending'
    })
  }

  const steamRoot = path.join(temp.path, 'Steam')
  await mkdir(path.join(steamRoot, 'userdata', '12345678', 'config'), { recursive: true })
  await writeFile(path.join(steamRoot, 'steam.exe'), '')

  const stateWrites: Array<{ jobPath: string; statePath: string }> = []
  const service = new SteamService({
    catalog: catalog.repository,
    artwork,
    artworkStorage,
    settings,
    steam,
    paths,
    log,
    steamRootOverride: steamRoot,
    runningOverride: false,
    launchWorker: async (jobPath, statePath) => {
      stateWrites.push({ jobPath, statePath })
      const job = JSON.parse(await readFile(jobPath, 'utf8')) as SteamSyncJob
      await runSteamSync(job, {
        deps: {
          isSteamRunning: async () => false,
          requestSteamShutdown: async () => undefined,
          launchSteamBigPicture: async () => undefined,
          sleep: async () => undefined
        }
      })
    }
  })
  return {
    temp,
    paths,
    database,
    settings,
    log,
    catalog,
    artwork,
    artworkStorage,
    enrichment,
    steam,
    installs,
    service,
    steamRoot,
    installDir,
    stateWrites
  }
}

describe('servicio de integración con Steam', () => {
  it('detecta el perfil, prepara cambios y ejecuta un sync con artwork e icono', async () => {
    const h = await harness()
    const status = await h.service.getStatus()
    expect(status.installed).toBe(true)
    expect(status.accounts).toHaveLength(1)
    expect(status.selectedAccountId).toBe('12345678')
    expect(status.pendingChanges.some((change) => change.gameId === 'example-quest')).toBe(true)

    const result = await h.service.startSync(true)
    expect(result.scheduled).toBe(true)
    expect(h.stateWrites).toHaveLength(1)

    const job = JSON.parse(await readFile(h.stateWrites[0]?.jobPath as string, 'utf8')) as {
      desired: Array<{ gameId: string; exePath: string; appId?: number; iconPath?: string }>
      artwork: Array<{ appId: number; kind: string; sourcePath: string }>
      managedRefs: Array<{ gameId: string; appId: number }>
      backupDir: string
    }
    const desired = job.desired.find((entry) => entry.gameId === 'example-quest')
    expect(desired?.exePath).toBe(path.join(h.installDir, 'bin', 'ExampleQuest.exe'))
    expect(desired?.appId).toBeTypeOf('number')
    expect(desired?.iconPath).toMatch(/\.ico$/)
    await expect(access(desired?.iconPath as string)).resolves.toBeUndefined()
    const ico = await readFile(desired?.iconPath as string)
    expect(ico.subarray(0, 4).toString('hex')).toBe('00000100')
    expect(job.artwork.length).toBeGreaterThanOrEqual(4)
    expect(job.artwork.some((item) => item.kind === 'portrait')).toBe(true)
    expect(job.managedRefs).toHaveLength(1)
    expect(job.backupDir).toBe(h.paths.steamBackups)

    await h.service.processPendingResults()
    const last = await h.service.getLastResult()
    expect(last?.status).toBe('completed')
    expect(last?.appliedGameIds).toContain('example-quest')
    const managed = h.steam.listManagedRefs('12345678')
    expect(managed).toHaveLength(1)
    const after = await h.service.getStatus()
    expect(after.pendingChanges).toHaveLength(0)
    const game = h.catalog.getGame('example-quest')
    expect(game?.steam.syncState).toBe('synced')
    expect(game?.steam.managedShortcutAppId).toBe(managed[0]?.appId)
  })

  it('rechaza iniciar sin confirmación explícita', async () => {
    const h = await harness()
    await expect(h.service.startSync(false)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
    expect(h.stateWrites).toHaveLength(0)
  })

  it('serializa dos solicitudes de sincronización concurrentes', async () => {
    const h = await harness()
    const outcomes = await Promise.allSettled([
      h.service.startSync(true),
      h.service.startSync(true)
    ])
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((entry) => entry.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expect((rejected.reason as { code?: string }).code).toBe('STEAM_BUSY')
    }
    expect(h.stateWrites).toHaveLength(1)
    await h.service.processPendingResults()
  })

  it('recupera una sincronización huérfana en estado running en lugar de bloquear para siempre', async () => {
    const h = await harness()
    const game = h.catalog.getGame('example-quest')
    if (!game) throw new Error('sin juego')
    const statePath = path.join(h.temp.path, 'stale-state.json')
    const job = {
      schemaVersion: 1 as const,
      id: 'stale-sync',
      steamRoot: h.steamRoot,
      accountId: '12345678',
      desired: [],
      managedRefs: [],
      artwork: [],
      backupDir: h.paths.steamBackups,
      statePath,
      reopen: 'never' as const
    }
    h.steam.createSyncRunning('stale-sync', {
      job,
      jobPath: path.join(h.temp.path, 'stale-job.json'),
      statePath
    })
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        jobId: 'stale-sync',
        status: 'running',
        phase: 'applying',
        requestedAt: new Date(Date.now() - 600_000).toISOString(),
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        updatedAt: new Date(Date.now() - 600_000).toISOString(),
        steamRoot: h.steamRoot,
        accountId: '12345678',
        shortcutsPath: '',
        steamWasRunning: false,
        steamClosed: false,
        steamRestarted: false,
        appliedGameIds: [],
        managedAppIds: {},
        collisions: [],
        artworkApplied: [],
        plannedChanges: [],
        retryable: true,
        warnings: [],
        dryRun: false,
        job
      }),
      'utf8'
    )
    const old = new Date(Date.now() - 600_000)
    await utimes(statePath, old, old)
    await h.service.processPendingResults()
    expect(h.steam.listRunningSyncRows()).toHaveLength(0)
    const last = await h.service.getLastResult()
    expect(last?.status).toBe('failed')
    expect(last?.error?.code).toBe('STEAM_SYNC_FAILED')
  })

  it('conserva referencias gestionadas separadas por cuenta de Steam', async () => {
    const h = await harness()
    const base = {
      gameId: 'example-quest',
      displayName: 'Example Quest',
      exePath: path.join(h.installDir, 'bin', 'ExampleQuest.exe'),
      startDir: path.join(h.installDir, 'bin'),
      launchOptions: '',
      tags: [],
      iconPath: undefined
    }
    h.steam.upsertManagedShortcut('111', { ...base, appId: 1001 })
    h.steam.upsertManagedShortcut('222', { ...base, appId: 1002 })
    expect(h.steam.listManagedRefs('111')).toEqual([{ gameId: 'example-quest', appId: 1001 }])
    expect(h.steam.listManagedRefs('222')).toEqual([{ gameId: 'example-quest', appId: 1002 }])
  })

  it('no adopta un acceso ajeno con el mismo ejecutable y lo reporta como conflicto', async () => {
    const h = await harness()
    const exePath = path.join(h.installDir, 'bin', 'ExampleQuest.exe')
    const snapshot = await readAccountShortcuts(h.steamRoot, '12345678', { allowMissing: true })
    const foreign = planShortcutChanges(
      snapshot.root,
      [
        {
          gameId: 'foreign-game',
          appName: 'Example Quest',
          exePath,
          startDir: path.dirname(exePath),
          tags: []
        }
      ],
      [],
      { tagMode: 'merge' }
    )
    const applied = applyShortcutPlan(snapshot.root, foreign)
    await writeShortcutsAtomic(steamShortcutsPath(h.steamRoot, '12345678'), applied.root, {
      backupDir: h.paths.steamBackups
    })

    const status = await h.service.getStatus()
    expect(status.pendingChanges.some((change) => change.gameId === 'example-quest')).toBe(true)
    await expect(h.service.startSync(true)).rejects.toMatchObject({ code: 'STEAM_SYNC_FAILED' })
    expect(h.stateWrites).toHaveLength(0)

    const after = await readAccountShortcuts(h.steamRoot, '12345678', { allowMissing: true })
    expect(after.root.entries.length).toBeGreaterThan(0)
  })
})
