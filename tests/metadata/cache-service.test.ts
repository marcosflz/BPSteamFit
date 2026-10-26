import { describe, expect, it } from 'vitest'
import type { ArtworkKind, GameMetadata } from '@shared/domain'
import { AppError } from '@shared/errors'
import { buildCacheKey, MemoryMetadataCache } from '@core/metadata/cache'
import { MockMetadataProvider } from '@core/metadata/mock-provider'
import { MetadataService } from '@core/metadata/service'
import type {
  ArtworkCandidate,
  MetadataCache,
  MetadataCacheRecord,
  MetadataProvider,
  ProviderCandidate,
  SearchHints
} from '@core/metadata/types'

class CountingProvider implements MetadataProvider {
  readonly info = new MockMetadataProvider().info
  calls = { search: 0, game: 0, artwork: 0 }
  fail = false
  configured = true

  isConfigured(): boolean {
    return this.configured
  }

  async searchCandidates(_query: string, _hints: SearchHints): Promise<ProviderCandidate[]> {
    this.calls.search += 1
    if (this.fail) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'El proveedor de pruebas falló.')
    }
    return [
      {
        key: 'mock:eq-2026',
        provider: 'mock',
        providerId: 'eq-2026',
        title: 'Example Quest',
        releaseYear: 2026
      }
    ]
  }

  async getGame(providerId: string): Promise<GameMetadata> {
    this.calls.game += 1
    if (this.fail) throw new AppError('METADATA_PROVIDER_FAILED', 'El proveedor de pruebas falló.')
    return {
      title: 'Example Quest',
      provider: 'mock',
      providerId,
      releaseYear: 2026,
      fetchedAt: '2026-10-26T12:00:00.000Z',
      isMock: true
    }
  }

  async listArtwork(providerGameId: string, kind: ArtworkKind): Promise<ArtworkCandidate[]> {
    this.calls.artwork += 1
    if (this.fail) throw new AppError('METADATA_PROVIDER_FAILED', 'El proveedor de pruebas falló.')
    return [
      {
        provider: 'mock',
        providerAssetId: 'art-1',
        providerGameId,
        kind,
        url: 'data:image/png;base64,iVBORw0KGgo=',
        width: 600,
        height: 900,
        mime: 'image/png',
        isMock: true
      }
    ]
  }
}

class BrokenCache implements MetadataCache {
  async get(_key: string): Promise<MetadataCacheRecord | null> {
    throw new Error('sqlite caído')
  }

  async set(_record: MetadataCacheRecord): Promise<void> {
    throw new Error('sqlite caído')
  }

  async delete(_key: string): Promise<void> {
    throw new Error('sqlite caído')
  }
}

function makeService(options: {
  provider?: CountingProvider
  cache?: MetadataCache
  offline?: boolean
  now?: () => Date
  searchTtlMs?: number
} = {}): { service: MetadataService; provider: CountingProvider; cache: MemoryMetadataCache } {
  const provider = options.provider ?? new CountingProvider()
  const cache = (options.cache as MemoryMetadataCache | undefined) ?? new MemoryMetadataCache()
  const service = new MetadataService({
    provider,
    cache: options.cache ?? cache,
    offline: options.offline,
    language: 'es',
    now: options.now ?? (() => new Date('2026-10-26T12:00:00.000Z')),
    searchTtlMs: options.searchTtlMs ?? 60_000,
    detailsTtlMs: 60_000,
    artworkTtlMs: 60_000
  })
  return { service, provider, cache }
}

describe('MetadataService y caché', () => {
  it('consulta al proveedor en miss y sirve caché en hit', async () => {
    const { service, provider, cache } = makeService()
    const first = await service.search('Example Quest', { releaseYear: 2026 })
    expect(first.source).toBe('provider')
    expect(first.error).toBeUndefined()
    expect(first.data?.[0]?.providerId).toBe('eq-2026')
    expect(provider.calls.search).toBe(1)
    expect(cache.size()).toBe(1)

    const second = await service.search('Example Quest', { releaseYear: 2026 })
    expect(second.source).toBe('cache')
    expect(second.stale).toBe(false)
    expect(second.data?.[0]?.providerId).toBe('eq-2026')
    expect(provider.calls.search).toBe(1)
  })

  it('vuelve a consultar al proveedor si se fuerza la actualización', async () => {
    const { service, provider } = makeService()
    await service.search('Example Quest')
    const refreshed = await service.search('Example Quest', {}, { forceRefresh: true })
    expect(refreshed.source).toBe('provider')
    expect(provider.calls.search).toBe(2)
  })

  it('respeta la expiración de la caché', async () => {
    let now = new Date('2026-10-26T12:00:00.000Z')
    const { service, provider } = makeService({ now: () => now, searchTtlMs: 1_000 })
    await service.search('Example Quest')
    now = new Date('2026-10-26T12:00:02.000Z')
    const result = await service.search('Example Quest')
    expect(result.source).toBe('provider')
    expect(provider.calls.search).toBe(2)
  })

  it('en offline no llama al proveedor', async () => {
    const { service, provider } = makeService({ offline: true })
    const result = await service.search('Example Quest')
    expect(provider.calls.search).toBe(0)
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('METADATA_OFFLINE')
    expect(result.warning).toMatch(/offline/i)
  })

  it('en offline sirve caché aunque esté expirada', async () => {
    let now = new Date('2026-10-26T12:00:00.000Z')
    const { service, provider } = makeService({ now: () => now, searchTtlMs: 1_000 })
    await service.search('Example Quest')
    now = new Date('2026-10-28T12:00:00.000Z')
    service.setOffline(true)
    const result = await service.search('Example Quest')
    expect(provider.calls.search).toBe(1)
    expect(result.source).toBe('cache')
    expect(result.stale).toBe(true)
    expect(result.data?.[0]?.providerId).toBe('eq-2026')
    expect(result.warning).toMatch(/offline/i)
  })

  it('usa caché obsoleta si el proveedor falla y no bloquea', async () => {
    let now = new Date('2026-10-26T12:00:00.000Z')
    const { service, provider } = makeService({ now: () => now, searchTtlMs: 1_000 })
    await service.search('Example Quest')
    now = new Date('2026-10-26T12:00:05.000Z')
    provider.fail = true
    const result = await service.search('Example Quest')
    expect(result.source).toBe('cache')
    expect(result.stale).toBe(true)
    expect(result.data?.[0]?.providerId).toBe('eq-2026')
    expect(result.error?.code).toBe('METADATA_PROVIDER_FAILED')
    expect(result.warning).toMatch(/datos guardados/i)
  })

  it('devuelve error tipado si falla el proveedor y no hay caché', async () => {
    const { service, provider } = makeService()
    provider.fail = true
    const result = await service.search('Example Quest')
    expect(result.data).toBeNull()
    expect(result.source).toBe('none')
    expect(result.error?.code).toBe('METADATA_PROVIDER_FAILED')
  })

  it('no bloquea si la caché falla', async () => {
    const provider = new CountingProvider()
    const service = new MetadataService({
      provider,
      cache: new BrokenCache(),
      language: 'es',
      now: () => new Date('2026-10-26T12:00:00.000Z')
    })
    const result = await service.search('Example Quest')
    expect(result.data?.[0]?.providerId).toBe('eq-2026')
    expect(result.source).toBe('provider')
    expect(result.warning).toMatch(/caché/i)
  })

  it('devuelve AUTH_REQUIRED sin llamar si el proveedor no está configurado', async () => {
    const provider = new CountingProvider()
    provider.configured = false
    const { service } = makeService({ provider })
    const result = await service.search('Example Quest')
    expect(provider.calls.search).toBe(0)
    expect(result.error?.code).toBe('METADATA_AUTH_REQUIRED')
  })

  it('ignora registros de caché corruptos', async () => {
    const provider = new CountingProvider()
    const cache = new MemoryMetadataCache()
    const key = buildCacheKey('mock', 'search', {
      query: 'Example Quest',
      hints: {},
      language: 'es'
    })
    await cache.set({
      key,
      provider: 'mock',
      value: { not: 'a candidate array' },
      createdAt: '2026-10-26T12:00:00.000Z',
      expiresAt: '2027-10-26T12:00:00.000Z'
    })
    const service = new MetadataService({
      provider,
      cache,
      language: 'es',
      now: () => new Date('2026-10-26T12:00:00.000Z')
    })
    const result = await service.search('Example Quest')
    expect(result.source).toBe('provider')
    expect(provider.calls.search).toBe(1)
    expect(result.warning).toMatch(/ignoró/i)
  })

  it('cachea detalles y listas de artwork por separado', async () => {
    const { service, provider } = makeService()
    await service.getGame('eq-2026')
    await service.getGame('eq-2026')
    await service.listArtwork('eq-2026', 'portrait')
    await service.listArtwork('eq-2026', 'portrait')
    expect(provider.calls.game).toBe(1)
    expect(provider.calls.artwork).toBe(1)
  })
})
