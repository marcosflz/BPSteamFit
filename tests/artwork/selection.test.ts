import { describe, expect, it } from 'vitest'
import type { ArtworkKind, ArtworkView } from '@shared/domain'
import {
  buildArtworkGallery,
  canAutoReplaceArtwork,
  galleryArtworkSet,
  markManualArtwork,
  reconcileArtworkSelection,
  selectBestArtworkView,
  selectGalleryArtwork
} from '@core/artwork/gallery'
import { rankArtworkCandidates, selectArtworkCandidate } from '@core/artwork/ranking'
import type { ArtworkCandidate } from '@core/metadata/types'

function art(
  id: string,
  kind: ArtworkKind,
  width?: number,
  height?: number,
  extra: Partial<ArtworkCandidate> = {}
): ArtworkCandidate {
  return {
    provider: 'mock',
    providerAssetId: id,
    providerGameId: 'eq-2026',
    kind,
    url: 'data:image/png;base64,AA==',
    width,
    height,
    mime: 'image/png',
    style: 'alternate',
    isMock: true,
    ...extra
  }
}

function viewFrom(item: ReturnType<typeof buildArtworkGallery>[number]): ArtworkView {
  return {
    id: item.id,
    kind: item.kind,
    provider: item.provider,
    providerGameId: item.providerGameId,
    width: item.width,
    height: item.height,
    source: item.source,
    chosen: item.chosen,
    previewUrl: item.previewUrl,
    createdAt: item.createdAt
  }
}

describe('selección de artwork por tipo y aspecto', () => {
  it('nunca usa un portrait como hero', () => {
    const portrait = art('portrait', 'portrait', 600, 900)
    const mislabeled = art('mislabeled', 'hero', 600, 900)
    const hero = art('hero', 'hero', 1920, 620)
    const selected = selectArtworkCandidate([portrait, mislabeled, hero], 'hero')
    expect(selected?.candidate.providerAssetId).toBe('hero')
    expect(selectArtworkCandidate([portrait, mislabeled], 'hero')).toBeNull()
  })

  it('prefiere mayor resolución y mantiene orden determinista', () => {
    const normal = art('normal', 'hero', 1920, 620)
    const large = art('large', 'hero', 3840, 1240)
    expect(selectArtworkCandidate([normal, large], 'hero')?.candidate.providerAssetId).toBe('large')

    const a = art('a', 'hero', 1920, 620, { style: 'material' })
    const b = art('b', 'hero', 1920, 620, { style: 'material' })
    expect(selectArtworkCandidate([b, a], 'hero')?.candidate.providerAssetId).toBe('a')
  })

  it('descarta candidatos marcados como sensibles', () => {
    const safe = art('safe', 'portrait', 600, 900)
    const nsfw = art('nsfw', 'portrait', 600, 900, { tags: ['nsfw'] })
    expect(rankArtworkCandidates([nsfw, safe], 'portrait')).toHaveLength(1)
    expect(selectArtworkCandidate([nsfw], 'portrait')).toBeNull()
  })

  it('premia estilos oficiales en logos', () => {
    const custom = art('custom', 'logo', 900, 300, { style: 'custom' })
    const official = art('official', 'logo', 900, 300, { style: 'official' })
    expect(selectArtworkCandidate([custom, official], 'logo')?.candidate.providerAssetId).toBe(
      'official'
    )
  })

  it('construye galería con selección automática por tipo', () => {
    const gallery = buildArtworkGallery(
      [art('p', 'portrait', 600, 900), art('h', 'hero', 1920, 620), art('l', 'logo', 900, 300)],
      { autoSelect: true, now: () => new Date('2026-10-26T12:00:00.000Z') }
    )
    expect(gallery.filter((item) => item.selected).map((item) => item.kind).sort()).toEqual([
      'hero',
      'logo',
      'portrait'
    ])
    const set = galleryArtworkSet(gallery)
    expect(set.portrait?.kind).toBe('portrait')
    expect(set.hero?.kind).toBe('hero')
    expect(set.logo?.kind).toBe('logo')
  })

  it('una preferencia manual no se pisa con una actualización', () => {
    const first = buildArtworkGallery([art('a', 'hero', 1920, 620), art('b', 'hero', 1920, 620)], {
      autoSelect: true
    })
    const manual = markManualArtwork(viewFrom(first[0]!))
    expect(canAutoReplaceArtwork(manual)).toBe(false)

    const updated = buildArtworkGallery(
      [art('a', 'hero', 1920, 620), art('b', 'hero', 1920, 620)],
      { current: manual, selectedId: 'mock:b' }
    )
    const selected = updated.find((item) => item.selected)
    expect(selected?.id).toBe(manual.id)
    expect(selected?.source).toBe('manual')

    const replacement = viewFrom(updated.find((item) => !item.selected)!)
    const kept = reconcileArtworkSelection(manual, replacement)
    expect(kept.id).toBe(manual.id)
    expect(kept.source).toBe('manual')
    const forced = reconcileArtworkSelection(manual, replacement, { force: true })
    expect(forced.id).toBe(replacement.id)
  })

  it('marca la selección manual de la galería y conserva solo una', () => {
    const gallery = buildArtworkGallery(
      [art('p', 'portrait', 600, 900), art('h', 'hero', 1920, 620)],
      { autoSelect: false }
    )
    const selected = selectGalleryArtwork(gallery, 'mock:h')
    const chosen = selected.filter((item) => item.selected)
    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.id).toBe('mock:h')
    expect(chosen[0]?.source).toBe('manual')
    expect(chosen[0]?.chosen).toBe(true)
    expect(() => selectGalleryArtwork(gallery, 'no-existe')).toThrow(/no existe/i)
  })

  it('expone una vista del mejor candidato sin persistir', () => {
    const view = selectBestArtworkView(
      [art('mislabeled', 'hero', 600, 900), art('hero', 'hero', 1920, 620)],
      'hero',
      { now: new Date('2026-10-26T12:00:00.000Z') }
    )
    expect(view?.id).toBe('mock:hero')
    expect(view?.chosen).toBe(true)
  })
})
