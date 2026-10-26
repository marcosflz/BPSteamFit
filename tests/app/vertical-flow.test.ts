import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/core/catalog/catalog-service'
import { createAppPaths, ensureBaseDirectories } from '../../src/core/config/app-paths'
import { InstallService } from '../../src/core/install/install-service'
import { FileLog } from '../../src/core/logging/install-log'
import { AppDatabase } from '../../src/core/storage/database'
import { InstallRepository } from '../../src/core/storage/install-repository'
import { SettingsRepository } from '../../src/core/storage/settings-repository'
import { buildDemoVariant, copyDemoTo, demoPackagePath } from '../helpers/demo'
import { makeTempDir, waitFor } from '../helpers/temp'

const cleanups: Array<() => Promise<void>> = []
const databases: AppDatabase[] = []
const logs: FileLog[] = []

afterEach(async () => {
  for (const log of logs.splice(0)) await log.close()
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Ya cerrada.
    }
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setupHarness() {
  const temp = await makeTempDir('bpsfit-flow-')
  cleanups.push(temp.cleanup)
  const home = path.join(temp.path, 'home')
  const userData = path.join(temp.path, 'appdata')
  const paths = createAppPaths(userData)
  await ensureBaseDirectories(paths)
  await mkdir(path.join(home, 'BPSteamFit', 'Packages'), { recursive: true })
  const database = AppDatabase.open(':memory:')
  databases.push(database)
  const settings = new SettingsRepository(database, home)
  const log = await FileLog.create(path.join(userData, 'logs', 'test-app.log'))
  logs.push(log)
  const metadataQueue: string[] = []
  const catalog = new CatalogService({
    database,
    paths,
    settings,
    log,
    onGameImported: (gameId) => metadataQueue.push(gameId)
  })
  const installEvents: string[] = []
  const install = new InstallService({
    database,
    paths,
    settings,
    catalog,
    log,
    appRoot: process.cwd(),
    onInstallProgress: (_gameId, snapshot) => installEvents.push(snapshot.state),
    onCatalogChanged: () => undefined
  })
  return { temp, home, userData, paths, database, settings, log, catalog, install, metadataQueue, installEvents }
}

describe('flujo vertical catálogo → instalación → verificación', () => {
  it('importa el demo, lo instala con el motor real y prepara Steam', async () => {
    const harness = await setupHarness()
    const { settings, catalog, install, metadataQueue } = harness
    const packageFolder = settings.get().packageFolders[0] as string
    await copyDemoTo(packageFolder)

    const summary = await catalog.scan()
    expect(summary.issues).toEqual([])
    expect(summary.imported).toBe(1)
    expect(metadataQueue).toEqual(['example-quest'])

    const library = catalog.getGames()
    expect(library).toHaveLength(1)
    expect(library[0]?.id).toBe('example-quest')
    expect(library[0]?.install.state).toBe('available')
    expect(library[0]?.metadata).toBeNull()
    expect(library[0]?.artwork).toEqual({})

    const started = await install.startInstall({ gameId: 'example-quest' })
    expect(started.snapshot.state).toBe('validating')

    const finalSnapshot = await waitFor(
      async () => install.getSnapshot('example-quest'),
      (snapshot) => ['installed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state),
      { timeoutMs: 30_000 }
    )
    expect(finalSnapshot.state).toBe('installed')
    expect(finalSnapshot.verification?.ok).toBe(true)
    expect(finalSnapshot.error).toBeUndefined()
    await waitFor(
      async () => harness.install.isBusy(),
      (busy) => busy === false,
      { timeoutMs: 5_000 }
    )

    const installedDir = finalSnapshot.installDir as string
    const installedFiles = await readdir(path.join(installedDir, 'bin'))
    expect(installedFiles).toContain('ExampleQuest.exe')
    expect(finalSnapshot.logPath).toBeTruthy()

    const updated = catalog.getGame('example-quest')
    expect(updated?.install.state).toBe('installed')
    expect(updated?.steam.syncState).toBe('pending')

    const revalidated = await install.revalidate('example-quest')
    expect(revalidated.install.state).toBe('installed')
    expect(revalidated.install.verification?.ok).toBe(true)

    // Segunda pasada: el paquete no se vuelve a importar ni se duplica.
    const second = await catalog.scan()
    expect(catalog.getGames()).toHaveLength(1)
    expect(second.imported).toBe(0)
  })

  it('rechaza una segunda instalación concurrente', async () => {
    const harness = await setupHarness()
    const packageFolder = harness.settings.get().packageFolders[0] as string
    await copyDemoTo(packageFolder)
    await harness.catalog.scan()

    const first = harness.install.startInstall({ gameId: 'example-quest' })
    const second = harness.install.startInstall({ gameId: 'example-quest' })
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((entry) => entry.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expect((rejected.reason as { code?: string }).code).toBe('INSTALL_BUSY')
    }
    const finalSnapshot = await waitFor(
      async () => harness.install.getSnapshot('example-quest'),
      (snapshot) => ['installed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state),
      { timeoutMs: 30_000 }
    )
    expect(finalSnapshot.state).toBe('installed')
    await waitFor(
      async () => harness.install.isBusy(),
      (busy) => busy === false,
      { timeoutMs: 5_000 }
    )
  })

  it('detecta cambios de versión, conflictos de hash y paquetes ausentes', async () => {
    const harness = await setupHarness()
    const { settings, catalog, temp } = harness
    const packageFolder = settings.get().packageFolders[0] as string
    await copyDemoTo(packageFolder)
    await catalog.scan()
    const initialGame = catalog.getGame('example-quest')
    new InstallRepository(harness.database).saveSnapshot(
      'example-quest',
      initialGame?.packageKey ?? '',
      {
        state: 'installed',
        installDir: path.join(temp.path, 'installs', 'v1'),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    )

    const newer = await buildDemoVariant(temp.path, 'v11', (manifest) => {
      manifest.version = '1.1.0'
    })
    await copyFile(newer.packagePath, path.join(packageFolder, 'ExampleQuest-v1.1.0.game'))
    const versionScan = await catalog.scan()
    expect(versionScan.imported).toBe(1)
    const versioned = catalog.getGame('example-quest')
    expect(versioned?.currentVersion).toBe('1.1.0')
    expect(versioned?.installedVersion).toBe('1.0.0')
    expect(versioned?.installedPackageKey).toBe('example-quest@1.0.0')
    expect(versioned?.availableVersions.map((entry) => entry.version)).toEqual(
      expect.arrayContaining(['1.0.0', '1.1.0'])
    )

    const conflictVariant = await buildDemoVariant(temp.path, 'conflict', (manifest) => {
      manifest.installation.arguments = ['/S', '/DIR={installDir}', '/FAIL']
    })
    await copyFile(conflictVariant.packagePath, path.join(packageFolder, 'ExampleQuest-conflicto.game'))
    const conflictScan = await catalog.scan()
    expect(
      conflictScan.issues.some((issue) => issue.code === 'PACKAGE_VERSION_CONFLICT')
    ).toBe(true)
    expect(catalog.getGames()).toHaveLength(1)
    expect(catalog.getGame('example-quest')?.currentVersion).toBe('1.1.0')

    await rm(path.join(packageFolder, 'ExampleQuest-v1.1.0.game'))
    const missingScan = await catalog.scan()
    expect(missingScan.unavailable).toBeGreaterThanOrEqual(1)
    expect(catalog.getGame('example-quest')?.currentVersion).toBe('1.0.0')
    expect(catalog.getGame('example-quest')?.packageAvailable).toBe(true)

    await copyFile(newer.packagePath, path.join(packageFolder, 'ExampleQuest-v1.1.0.game'))
    await catalog.scan()
    const restored = catalog.getGame('example-quest')
    expect(restored?.currentVersion).toBe('1.1.0')
    expect(restored?.installedVersion).toBe('1.0.0')
    expect(restored?.packageAvailable).toBe(true)
  })
})

describe('recuperación de interrupciones', () => {
  it('marca como interrumpida una instalación transitoria que quedó activa', async () => {
    const harness = await setupHarness()
    const packageFolder = harness.settings.get().packageFolders[0] as string
    await copyDemoTo(packageFolder)
    await harness.catalog.scan()
    const game = harness.catalog.getGame('example-quest')
    expect(game).not.toBeNull()
    const installs = new InstallRepository(harness.database)
    installs.saveSnapshot('example-quest', game?.packageKey ?? '', {
      state: 'installing',
      installDir: path.join(harness.temp.path, 'installs', 'Parcial'),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    expect(installs.getActiveCount()).toBe(1)
    const interrupted = installs.markInterruptedOnStartup()
    expect(interrupted).toHaveLength(1)
    const snapshot = installs.getSnapshot('example-quest')
    expect(snapshot?.state).toBe('interrupted')
    expect(snapshot?.error?.code).toBe('INSTALL_INTERRUPTED')
    expect(installs.getActiveCount()).toBe(0)
    expect(installs.listEvents('example-quest').length).toBeGreaterThanOrEqual(2)
  })
})

describe('paquete demo', () => {
  it('está generado y disponible para los tests', async () => {
    const { access } = await import('node:fs/promises')
    await expect(access(demoPackagePath)).resolves.toBeUndefined()
  })
})
