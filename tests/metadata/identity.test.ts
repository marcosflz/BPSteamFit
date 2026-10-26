import { describe, expect, it, vi } from 'vitest'
import type { GameMetadata } from '@shared/domain'
import { AppError } from '@shared/errors'
import { MemoryMetadataCache } from '@core/metadata/cache'
import {
  confirmIdentity,
  continueWithoutMetadata,
  correctIdentity,
  hintsFromManifest,
  IdentityService,
  isIdentityResolved,
  queryFromManifest
} from '@core/metadata/identity-service'
import { evaluateIdentity } from '@core/metadata/matching'
import { MockMetadataProvider } from '@core/metadata/mock-provider'
import { MetadataService } from '@core/metadata/service'
import type { MetadataProvider, ProviderCandidate } from '@core/metadata/types'

function makeIdentity(options: {
  offline?: boolean
  cache?: MemoryMetadataCache
  provider?: MetadataProvider
  language?: 'es' | 'en'
  now?: () => Date
} = {}): {
  identity: IdentityService
  service: MetadataService
  provider: MetadataProvider
} {
  const provider = options.provider ?? new MockMetadataProvider({ language: options.language ?? 'es' })
  const service = new MetadataService({
    provider,
    cache: options.cache,
    offline: options.offline,
    language: options.language ?? 'es',
    now: options.now ?? (() => new Date('2026-10-26T12:00:00.000Z'))
  })
  return {
    identity: new IdentityService({ service, now: options.now ?? (() => new Date('2026-10-26T12:00:00.000Z')) }),
    service,
    provider
  }
}

function failingProvider(): MetadataProvider {
  const mock = new MockMetadataProvider()
  return {
    info: mock.info,
    isConfigured: () => true,
    searchCandidates: async () => {
      throw new AppError('METADATA_PROVIDER_FAILED', 'El proveedor de pruebas está caído.')
    },
    getGame: async (): Promise<GameMetadata> => {
      throw new AppError('METADATA_PROVIDER_FAILED', 'El proveedor de pruebas está caído.')
    },
    listArtwork: async () => []
  }
}

function candidate(
  providerId: string,
  title: string,
  releaseYear: number,
  overrides: Partial<ProviderCandidate> = {}
): ProviderCandidate {
  return {
    key: `mock:${providerId}`,
    provider: 'mock',
    providerId,
    title,
    releaseYear,
    ...overrides
  }
}

describe('resolución de identidad', () => {
  it('auto-selecciona un título exacto con año compatible y ventaja clara', async () => {
    const { identity } = makeIdentity()
    const result = await identity.resolve({
      query: 'Example Quest',
      hints: { releaseYear: 2026 }
    })
    expect(result.state.status).toBe('auto')
    expect(result.state.providerId).toBe('eq-2026')
    expect(result.state.decidedBy).toBe('auto')
    expect(result.selected?.providerId).toBe('eq-2026')
    expect(result.fromCache).toBe(false)
    expect(isIdentityResolved(result.state)).toBe(true)
  })

  it('no confunde una secuela con el juego base', async () => {
    const { identity } = makeIdentity()
    const result = await identity.resolve({
      query: 'Example Quest 2',
      hints: { releaseYear: 2028 }
    })
    expect(result.state.status).toBe('auto')
    expect(result.state.providerId).toBe('eq2-2028')
    expect(result.state.title).toBe('Example Quest 2')
  })

  it('no confunde el juego base con un remake de otro año', async () => {
    const { identity } = makeIdentity()
    const base = await identity.resolve({ query: 'Example Quest', hints: { releaseYear: 2026 } })
    expect(base.state.providerId).toBe('eq-2026')

    const remake = await identity.resolve({
      query: 'Example Quest Remake',
      hints: { releaseYear: 2024 }
    })
    expect(remake.state.status).toBe('auto')
    expect(remake.state.providerId).toBe('eq-remake-2024')
  })

  it('conserva la edición al resolver y no la elimina del título', async () => {
    const { identity } = makeIdentity()
    const deluxe = await identity.resolve({
      query: 'Example Quest',
      hints: { releaseYear: 2026, edition: 'Deluxe Edition' }
    })
    expect(deluxe.state.status).toBe('auto')
    expect(deluxe.state.providerId).toBe('eq-deluxe-2026')
    expect(deluxe.state.title).toBe('Example Quest: Deluxe Edition')

    const base = await identity.resolve({ query: 'Example Quest', hints: { releaseYear: 2026 } })
    expect(base.state.providerId).toBe('eq-2026')
  })

  it('deja ambigüedad cuando el año no es compatible', async () => {
    const { identity } = makeIdentity()
    const result = await identity.resolve({
      query: 'Example Quest',
      hints: { releaseYear: 2020 }
    })
    expect(result.state.status).toBe('ambiguous')
    expect(result.state.providerId).toBeUndefined()
    expect(result.selected).toBeUndefined()
    expect(result.state.candidates.length).toBeGreaterThan(1)
    expect(result.state.message).toMatch(/ambig|auto-selección|reglas/i)
  })

  it('deja ambigüedad ante títulos parecidos sin coincidencia exacta', () => {
    const evaluation = evaluateIdentity(
      'Example Quest',
      { releaseYear: 2026 },
      [
        candidate('eq2', 'Example Quest 2', 2028),
        candidate('remake', 'Example Quest Remake', 2024)
      ]
    )
    expect(evaluation.decision).toBe('ambiguous')
    expect(evaluation.selected).toBeUndefined()
  })

  it('no auto-selecciona un remaster como si fuera un remake', () => {
    const evaluation = evaluateIdentity(
      'Example Quest Remastered',
      { releaseYear: 2026 },
      [
        candidate('base', 'Example Quest', 2026),
        candidate('remake', 'Example Quest Remake', 2026)
      ]
    )
    expect(evaluation.decision).toBe('ambiguous')
  })

  it('respeta providerIds del manifiesto sin buscar por título', async () => {
    const { identity, provider } = makeIdentity()
    const spy = vi.spyOn(provider, 'searchCandidates')
    const result = await identity.resolve({
      query: 'Example Quest',
      hints: {
        releaseYear: 2026,
        providerIds: { mock: 'eq-deluxe-2026' }
      }
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.state.status).toBe('confirmed')
    expect(result.state.decidedBy).toBe('manifest')
    expect(result.state.providerId).toBe('eq-deluxe-2026')
    expect(result.fromCache).toBe(false)
  })

  it('no mezcla IDs del manifiesto de otro proveedor', async () => {
    const { identity, provider } = makeIdentity()
    const spy = vi.spyOn(provider, 'searchCandidates')
    const result = await identity.resolve({
      query: 'Example Quest',
      hints: { providerIds: { steamgriddb: '12345' } }
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.state.status).toBe('none')
    expect(result.state.message).toMatch(/otro proveedor|no se mezclan/i)
  })

  it('devuelve error tipado sin lanzar cuando falla el proveedor', async () => {
    const { identity } = makeIdentity({ provider: failingProvider() })
    const result = await identity.resolve({ query: 'Example Quest' })
    expect(result.state.status).toBe('none')
    expect(result.error?.code).toBe('METADATA_PROVIDER_FAILED')
    expect(result.state.candidates).toEqual([])
  })

  it('en offline no consulta al proveedor y usa la caché si existe', async () => {
    const cache = new MemoryMetadataCache()
    const { identity, service, provider } = makeIdentity({ cache })
    await identity.resolve({ query: 'Example Quest', hints: { releaseYear: 2026 } })
    const spy = vi.spyOn(provider, 'searchCandidates')

    service.setOffline(true)
    const offline = await identity.resolve({
      query: 'Example Quest',
      hints: { releaseYear: 2026 }
    })
    expect(spy).not.toHaveBeenCalled()
    expect(offline.fromCache).toBe(true)
    expect(offline.state.providerId).toBe('eq-2026')
  })

  it('en offline sin caché devuelve METADATA_OFFLINE', async () => {
    const { identity, provider } = makeIdentity({ offline: true })
    const spy = vi.spyOn(provider, 'searchCandidates')
    const result = await identity.resolve({ query: 'Example Quest' })
    expect(spy).not.toHaveBeenCalled()
    expect(result.state.status).toBe('none')
    expect(result.error?.code).toBe('METADATA_OFFLINE')
  })

  it('permite confirmar, corregir y continuar sin metadatos', async () => {
    const { identity } = makeIdentity()
    const ambiguous = await identity.resolve({
      query: 'Example Quest',
      hints: { releaseYear: 2020 }
    })
    const base = ambiguous.state.candidates.find((entry) => entry.providerId === 'eq-2026')
    const sequel = ambiguous.state.candidates.find((entry) => entry.providerId === 'eq2-2028')
    expect(base).toBeDefined()
    expect(sequel).toBeDefined()
    if (!base || !sequel) return

    const confirmed = confirmIdentity(ambiguous.state, base, {
      now: () => new Date('2026-10-27T00:00:00.000Z')
    })
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.decidedBy).toBe('user')
    expect(confirmed.providerId).toBe('eq-2026')

    const corrected = correctIdentity(confirmed, sequel, {
      now: () => new Date('2026-10-28T00:00:00.000Z')
    })
    expect(corrected.providerId).toBe('eq2-2028')
    expect(corrected.message).toMatch(/corregida/i)

    const skipped = continueWithoutMetadata(corrected, {
      now: () => new Date('2026-10-29T00:00:00.000Z')
    })
    expect(skipped.status).toBe('none')
    expect(skipped.providerId).toBeUndefined()
    expect(skipped.candidates.length).toBeGreaterThan(0)
    expect(skipped.message).toMatch(/sin metadatos/i)
  })

  it('obtiene metadatos ficticios tras resolver la identidad', async () => {
    const { identity } = makeIdentity()
    const result = await identity.resolve({ query: 'Example Quest', hints: { releaseYear: 2026 } })
    const metadata = await identity.metadataFor(result.state)
    expect(metadata.error).toBeUndefined()
    expect(metadata.data?.isMock).toBe(true)
    expect(metadata.data?.language).toBe('es')
    expect(metadata.data?.developers?.[0]).toMatch(/ficticio/i)
  })

  it('no pide metadatos de una identidad de otro proveedor', async () => {
    const { identity, provider } = makeIdentity()
    const spy = vi.spyOn(provider, 'getGame')
    const metadata = await identity.metadataFor({
      status: 'confirmed',
      provider: 'steamgriddb',
      providerId: '123',
      candidates: [],
      decidedBy: 'manifest'
    })
    expect(spy).not.toHaveBeenCalled()
    expect(metadata.error?.message).toMatch(/otro proveedor/i)
  })

  it('expone utilidades para el manifiesto', () => {
    expect(
      hintsFromManifest({
        searchTitle: 'Example Quest',
        releaseYear: 2026,
        edition: 'Deluxe Edition',
        providerIds: { mock: 'eq-deluxe-2026' }
      })
    ).toEqual({
      releaseYear: 2026,
      edition: 'Deluxe Edition',
      providerIds: { mock: 'eq-deluxe-2026' }
    })
    expect(queryFromManifest({ searchTitle: 'Example Quest 2' }, 'Fallback')).toBe('Example Quest 2')
    expect(queryFromManifest(undefined, '  Fallback  ')).toBe('Fallback')
  })
})
