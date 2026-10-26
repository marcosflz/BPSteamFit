import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { ArtworkKind } from '@shared/domain'
import { createPlaceholderArtwork } from '@core/artwork/placeholder'

describe('placeholder local de artwork', () => {
  it('genera tamaños propios por tipo sin IA ni originales', async () => {
    const expected: Record<ArtworkKind, [number, number]> = {
      portrait: [600, 900],
      hero: [1920, 620],
      logo: [1000, 400],
      icon: [256, 256],
      screenshot: [1920, 1080]
    }
    for (const [kind, dimensions] of Object.entries(expected)) {
      const placeholder = await createPlaceholderArtwork({
        title: 'Example Quest',
        kind: kind as ArtworkKind
      })
      expect([placeholder.width, placeholder.height]).toEqual(dimensions)
      expect(placeholder.mime).toBe('image/png')
      expect(placeholder.initials).toBe('EQ')
      const metadata = await sharp(placeholder.bytes).metadata()
      expect(metadata.format).toBe('png')
      expect(metadata.width).toBe(dimensions[0])
      expect(metadata.height).toBe(dimensions[1])
      if (kind === 'logo') expect(metadata.hasAlpha).toBe(true)
    }
  })

  it('es determinista para el mismo título', async () => {
    const first = await createPlaceholderArtwork({ title: 'Faro Norte', kind: 'portrait' })
    const second = await createPlaceholderArtwork({ title: 'Faro Norte', kind: 'portrait' })
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true)
  })

  it('escapa el título y acepta iniciales manuales', async () => {
    const placeholder = await createPlaceholderArtwork({
      title: 'A < B & "C"',
      kind: 'hero',
      initials: 'ABC'
    })
    expect(placeholder.initials).toBe('ABC')
    expect(placeholder.bytes.byteLength).toBeGreaterThan(0)
  })

  it('rechaza títulos vacíos', async () => {
    await expect(
      createPlaceholderArtwork({ title: '   ', kind: 'icon' })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })
})
