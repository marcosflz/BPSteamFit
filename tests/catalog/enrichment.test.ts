import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/core/catalog/catalog-service'
import { EnrichmentService } from '../../src/core/catalog/enrichment-service'
import { createAppPaths, ensureBaseDirectories } from '../../src/core/config/app-paths'
import { FileLog } from '../../src/core/logging/install-log'
import { FileArtworkStorage } from '../../src/core/storage/artwork-storage'
import { ArtworkRepository } from '../../src/core/storage/artwork-repository'
import { AppDatabase } from '../../src/core/storage/database'
import { SqliteMetadataCache } from '../../src/core/storage/metadata-cache-repository'
import { SettingsRepository } from '../../src/core/storage/settings-repository'
import { buildDemoVariant, copyDemoTo } from '../helpers/demo'
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
      // ya cerrada
    }
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const temp = await makeTempDir('bpsfit-enrich-')
  cleanups.push(temp.cleanup)
  const home = path.join(temp.path, 'home')
  const userData = path.join(temp.path, 'appdata')
  const paths = createAppPaths(userData)
  await ensureBaseDirectories(paths)
  const database = AppDatabase.open(':memory:')
  databases.push(database)
  const settings = new SettingsRepository(database, home)
  const log = await FileLog.create(path.join(userData, 'logs', 'enrich.log'))
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
  const folder = settings.get().packageFolders[0] as string
  await mkdir(folder, { recursive: true })
  return {
    temp,
    home,
    userData,
    paths,
    database,
    settings,
    log,
    catalog,
    artwork,
    artworkStorage,
    cache,
    enrichment,
    folder
  }
}

describe('enriquecimiento mock offline', () => {
  it('resuelve el demo por providerIds y genera metadatos y artwork local', async () => {
    const harness = await setup()
    await copyDemoTo(harness.folder)
    await harness.catalog.scan()

    const game = await harness.enrichment.refresh('example-quest', {
      forceIdentity: true,
      forceDetails: true,
      forceArtwork: true
    })
    expect(game.identity.status).toBe('confirmed')
    expect(game.identity.provider).toBe('mock')
    expect(game.metadata?.isMock).toBe(true)
    expect(game.metadata?.language).toBe('es')
    expect(game.metadata?.title).toBe('Example Quest')
    expect(game.artwork.portrait?.previewUrl).toContain('bps-media://')
    expect(game.artwork.portrait?.author).toBe('BPSteamFit')
    expect(game.artwork.portrait?.attribution).toBeTruthy()
    expect(game.artwork.hero?.previewUrl).toContain('bps-media://')
    expect(game.artwork.logo?.previewUrl).toBeTruthy()
    expect(game.artwork.icon?.previewUrl).toBeTruthy()

    const portrait = harness.artwork.getChosenRow('example-quest', 'portrait')
    expect(portrait).not.toBeNull()
    const previewKey = harness.artwork.getPreviewKey(portrait?.id ?? '')
    expect(previewKey).toBeTruthy()
    const resolved = await harness.artworkStorage.resolveFile(previewKey ?? '')
    expect(resolved).toBeTruthy()
    const metadata = await sharp(resolved as string).metadata()
    expect(metadata.width).toBe(600)
    expect(metadata.height).toBe(900)

    const cacheRow = harness.database
      .prepare('SELECT COUNT(*) AS count FROM metadata_cache')
      .get() as unknown as { count: number }
    expect(cacheRow.count).toBeGreaterThan(0)

    const status = harness.enrichment.getProviderStatus()
    expect(status.mock.available).toBe(true)
    expect(status.steamgriddb.configured).toBe(false)
  })

  it('mantiene una selección manual de artwork frente a actualizaciones automáticas', async () => {
    const harness = await setup()
    await copyDemoTo(harness.folder)
    await harness.catalog.scan()
    await harness.enrichment.refresh('example-quest', {
      forceIdentity: true,
      forceDetails: true,
      forceArtwork: true
    })

    const localPath = path.join(harness.temp.path, 'portada local.png')
    await sharp({
      create: {
        width: 600,
        height: 900,
        channels: 4,
        background: { r: 20, g: 40, b: 70, alpha: 1 }
      }
    })
      .png()
      .toFile(localPath)

    const afterManual = await harness.enrichment.importLocalArtwork(
      'example-quest',
      'portrait',
      localPath
    )
    expect(afterManual.artwork.portrait?.source).toBe('manual')
    const manualId = afterManual.artwork.portrait?.id

    const refreshed = await harness.enrichment.refresh('example-quest', {
      forceDetails: true,
      forceArtwork: true
    })
    expect(refreshed.artwork.portrait?.id).toBe(manualId)
    expect(refreshed.artwork.portrait?.source).toBe('manual')

    const gallery = await harness.enrichment.artworkGallery('example-quest', 'portrait')
    expect(gallery.some((item) => item.selected && item.id === manualId)).toBe(true)
  })

  it('no asocia silenciosamente un título ambiguo y permite elegir después', async () => {
    const harness = await setup()
    const variant = await buildDemoVariant(harness.temp.path, 'ambiguous', (manifest) => {
      manifest.id = 'example-ambiguous'
      manifest.name = 'Example Quest'
      manifest.version = '1.0.0'
      manifest.metadata = {
        searchTitle: 'Quest'
      }
    })
    await copyFile(variant.packagePath, path.join(harness.folder, 'ExampleQuest-ambiguo.game'))
    await harness.catalog.scan()

    const ambiguous = await harness.enrichment.refresh('example-ambiguous', {
      forceIdentity: true,
      forceDetails: true,
      forceArtwork: true
    })
    expect(['ambiguous', 'none']).toContain(ambiguous.identity.status)
    expect(ambiguous.identity.candidates.length).toBeGreaterThan(1)
    expect(ambiguous.metadata).toBeNull()
    expect(ambiguous.artwork.portrait).toBeUndefined()

    const chosen = await harness.enrichment.chooseIdentity(
      'example-ambiguous',
      ambiguous.identity.candidates[0]?.key ?? ''
    )
    expect(chosen.identity.status).toBe('confirmed')
    expect(chosen.metadata).not.toBeNull()
  })

  it('respeta "continuar sin metadatos" en refrescos automáticos posteriores', async () => {
    const harness = await setup()
    await copyDemoTo(harness.folder)
    await harness.catalog.scan()
    await harness.enrichment.refresh('example-quest', {
      forceIdentity: true,
      forceDetails: true,
      forceArtwork: true
    })
    const skipped = await harness.enrichment.clearIdentity('example-quest')
    expect(skipped.identity.status).toBe('none')
    expect(skipped.identity.decidedBy).toBe('user')
    expect(skipped.metadata).toBeNull()

    harness.enrichment.enqueueAuto('example-quest')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const stillSkipped = harness.catalog.getGame('example-quest')
    expect(stillSkipped?.identity.status).toBe('none')
    expect(stillSkipped?.identity.decidedBy).toBe('user')

    const refreshed = await harness.enrichment.refreshManual('example-quest')
    expect(refreshed.identity.status).toBe('confirmed')
  })

  it('actualiza los detalles al cambiar el idioma preferido de los metadatos', async () => {
    const harness = await setup()
    await copyDemoTo(harness.folder)
    await harness.catalog.scan()
    const spanish = await harness.enrichment.refresh('example-quest', {
      forceIdentity: true,
      forceDetails: true,
      forceArtwork: false
    })
    expect(spanish.metadata?.language).toBe('es')

    harness.settings.update({ referToMetadataInSpanish: false })
    const english = await harness.enrichment.refresh('example-quest', {
      forceIdentity: false,
      forceDetails: false,
      forceArtwork: false
    })
    expect(english.identity.provider).toBe('mock')
    expect(english.metadata?.language).toBe('en')
    expect(english.metadata?.title).toBe('Example Quest')
  })
})
