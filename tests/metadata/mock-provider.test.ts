import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { ArtworkKind } from '@shared/domain'
import { AppError } from '@shared/errors'
import { MockMetadataProvider } from '@core/metadata/mock-provider'
import { createMetadataProvider } from '@core/metadata/providers'
import { MetadataService } from '@core/metadata/service'
import { providerRuntimeState } from '@core/metadata/types'

function decodeDataUrl(value: string): Buffer {
  const comma = value.indexOf(',')
  if (comma < 0) throw new Error('Data URL inválido')
  return Buffer.from(value.slice(comma + 1), 'base64')
}

describe('proveedor mock offline', () => {
  it('devuelve los fixtures de ambigüedad con años distintos', async () => {
    const provider = new MockMetadataProvider()
    const candidates = await provider.searchCandidates('Example Quest', {})
    expect(candidates.map((entry) => entry.providerId).sort()).toEqual([
      'eq-2026',
      'eq-deluxe-2026',
      'eq-remake-2024',
      'eq2-2028'
    ])
    expect(candidates.find((entry) => entry.providerId === 'eq2-2028')?.releaseYear).toBe(2028)
    expect(candidates.find((entry) => entry.providerId === 'eq-remake-2024')?.releaseYear).toBe(2024)
    expect(candidates.every((entry) => entry.isMock === true)).toBe(true)
    expect(candidates.every((entry) => entry.provider === 'mock')).toBe(true)
  })

  it('devuelve metadatos en español e inglés marcados como mock', async () => {
    const es = await new MockMetadataProvider({ language: 'es' }).getGame('eq-2026')
    const en = await new MockMetadataProvider({ language: 'en' }).getGame('eq-2026')
    expect(es.isMock).toBe(true)
    expect(es.language).toBe('es')
    expect(es.title).toBe('Example Quest')
    expect(es.developers?.[0]).toMatch(/ficticio/i)
    expect(es.publishers?.[0]).toMatch(/ficticio/i)
    expect(es.description).toMatch(/ficticio/i)
    expect(en.language).toBe('en')
    expect(en.description).not.toBe(es.description)
    expect(en.description).toMatch(/fictional/i)
  })

  it('genera artwork original con las dimensiones requeridas', async () => {
    const provider = new MockMetadataProvider()
    const expected: Record<string, { width: number; height: number; count: number }> = {
      portrait: { width: 600, height: 900, count: 1 },
      hero: { width: 1920, height: 620, count: 1 },
      logo: { width: 900, height: 300, count: 1 },
      icon: { width: 256, height: 256, count: 1 },
      screenshot: { width: 1280, height: 720, count: 2 }
    }

    for (const [kind, target] of Object.entries(expected)) {
      const candidates = await provider.listArtwork('eq-2026', kind as ArtworkKind)
      expect(candidates).toHaveLength(target.count)
      for (const candidate of candidates) {
        expect(candidate.url.startsWith('data:image/png;base64,')).toBe(true)
        expect(candidate.kind).toBe(kind)
        expect(candidate.origin).toBe('mock')
        expect(candidate.width).toBe(target.width)
        expect(candidate.height).toBe(target.height)
        expect(candidate.attribution).toMatch(/BPSteamFit/)
        const metadata = await sharp(decodeDataUrl(candidate.url)).metadata()
        expect(metadata.width).toBe(target.width)
        expect(metadata.height).toBe(target.height)
        expect(metadata.format).toBe('png')
        if (kind === 'logo') expect(metadata.hasAlpha).toBe(true)
      }
    }
  })

  it('no requiere clave ni configuración externa', () => {
    const provider = new MockMetadataProvider()
    expect(provider.info.requiresKey).toBe(false)
    expect(provider.isConfigured()).toBe(true)
    expect(providerRuntimeState(provider)).toBe('available')
    expect(providerRuntimeState(provider, { offline: true })).toBe('offline')
    const status = new MetadataService({ provider }).getStatus()
    expect(status.mock.available).toBe(true)
    expect(status.steamgriddb.configured).toBe(false)
    expect(status.steamgriddb.attribution).toMatch(/SteamGridDB/)
  })

  it('la fábrica usa mock por defecto y no exige clave', () => {
    expect(createMetadataProvider().info.id).toBe('mock')
    const sgdb = createMetadataProvider({ provider: 'steamgriddb' })
    expect(sgdb.info.id).toBe('steamgriddb')
    expect(sgdb.isConfigured()).toBe(false)
    expect(sgdb.info.capabilities.screenshots).toBe(false)
  })

  it('responde con errores tipados para IDs desconocidos', async () => {
    const provider = new MockMetadataProvider()
    await expect(provider.getGame('no-existe')).rejects.toMatchObject({
      code: 'METADATA_PROVIDER_FAILED'
    })
    await expect(provider.listArtwork('no-existe', 'portrait')).rejects.toBeInstanceOf(AppError)
  })

  it('respeta AbortSignal', async () => {
    const provider = new MockMetadataProvider()
    const controller = new AbortController()
    controller.abort()
    await expect(provider.searchCandidates('Example Quest', {}, controller.signal)).rejects.toMatchObject({
      code: 'METADATA_PROVIDER_FAILED'
    })
  })
})
