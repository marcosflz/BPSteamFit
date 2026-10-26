import { describe, expect, it } from 'vitest'
import type { ArtworkKind } from '@shared/domain'
import { ArtworkIngestor } from '@core/artwork/ingest'
import { selectArtworkCandidate } from '@core/artwork/ranking'
import { MockMetadataProvider } from '@core/metadata/mock-provider'

describe('integración del artwork mock con la ingesta', () => {
  it('ingiere las cinco variantes sin usar red', async () => {
    const provider = new MockMetadataProvider()
    const ingestor = new ArtworkIngestor()
    const expected: Record<ArtworkKind, [number, number]> = {
      portrait: [600, 900],
      hero: [1920, 620],
      logo: [900, 300],
      icon: [256, 256],
      screenshot: [1280, 720]
    }

    for (const [kind, dimensions] of Object.entries(expected)) {
      const candidates = await provider.listArtwork('eq-2026', kind as ArtworkKind)
      const selected = selectArtworkCandidate(candidates, kind as ArtworkKind)
      expect(selected).not.toBeNull()
      if (!selected) continue
      const artwork = await ingestor.ingest(selected.candidate)
      expect([artwork.variant.width, artwork.variant.height]).toEqual(dimensions)
      expect(artwork.original.width).toBeGreaterThan(0)
      expect(artwork.original.height).toBeGreaterThan(0)
      expect(artwork.original.mime).toBe('image/png')
    }
  })
})
