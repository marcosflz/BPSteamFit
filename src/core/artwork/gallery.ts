import type { ArtworkGalleryItem, ArtworkKind, ArtworkSet, ArtworkView } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { ArtworkCandidate } from '../metadata/types'
import { rankArtworkCandidates, type ArtworkRankOptions } from './ranking'

export interface GalleryOptions {
  /** Si se indica, solo se listan candidatos de ese tipo. */
  kind?: ArtworkKind
  /** ID seleccionado por el usuario en una sesión anterior. */
  selectedId?: string
  /** Preferencia persistida; si es manual no se pisa automáticamente. */
  current?: ArtworkView
  autoSelect?: boolean
  now?: () => Date
  rank?: ArtworkRankOptions
}

export function artworkCandidateViewId(candidate: ArtworkCandidate): string {
  return `${candidate.provider}:${candidate.providerAssetId}`
}

export function galleryItemFromCandidate(
  candidate: ArtworkCandidate,
  options: {
    selected?: boolean
    manual?: boolean
    now?: Date
  } = {}
): ArtworkGalleryItem {
  const selected = options.selected ?? false
  return {
    id: artworkCandidateViewId(candidate),
    kind: candidate.kind,
    provider: candidate.provider,
    providerGameId: candidate.providerGameId,
    width: candidate.width,
    height: candidate.height,
    source: options.manual && selected ? 'manual' : 'provider',
    chosen: selected,
    previewUrl: candidate.thumbUrl ?? candidate.url,
    createdAt: candidate.createdAt ?? (options.now ?? new Date()).toISOString(),
    selected
  }
}

/**
 * Construye la galería ordenada. Si la selección actual es manual, sólo se
 * marca ese ID: una actualización del proveedor no puede pisarla.
 */
export function buildArtworkGallery(
  candidates: readonly ArtworkCandidate[],
  options: GalleryOptions = {}
): ArtworkGalleryItem[] {
  const now = options.now ?? (() => new Date())
  const ranked = rankArtworkCandidates(candidates, options.kind, options.rank)
  const manualLock = options.current?.source === 'manual'
  const autoIds = new Set<string>()

  if (options.autoSelect && !manualLock) {
    const byKind = new Map<ArtworkKind, ArtworkCandidate>()
    for (const entry of ranked) {
      if (!byKind.has(entry.candidate.kind)) byKind.set(entry.candidate.kind, entry.candidate)
    }
    for (const candidate of byKind.values()) autoIds.add(artworkCandidateViewId(candidate))
  }

  return ranked.map(({ candidate }) => {
    const id = artworkCandidateViewId(candidate)
    const selected =
      (options.current?.id === id && options.current.kind === candidate.kind) ||
      (!manualLock && (options.selectedId === id || autoIds.has(id)))
    return galleryItemFromCandidate(candidate, {
      selected,
      manual: manualLock && selected,
      now: now()
    })
  })
}

/** Selección manual: marca un único elemento y protege la preferencia. */
export function selectGalleryArtwork(
  items: readonly ArtworkGalleryItem[],
  id: string
): ArtworkGalleryItem[] {
  if (!items.some((item) => item.id === id)) {
    throw new AppError('ARTWORK_INVALID', 'El artwork seleccionado no existe en la galería.')
  }
  return items.map((item) => {
    const selected = item.id === id
    return {
      ...item,
      selected,
      chosen: selected,
      source: selected ? 'manual' : item.source
    }
  })
}

/** Convierte las selecciones de la galería en el `ArtworkSet` del catálogo. */
export function galleryArtworkSet(items: readonly ArtworkGalleryItem[]): ArtworkSet {
  const set: ArtworkSet = {}
  for (const item of items) {
    if (!item.selected) continue
    set[item.kind] = {
      id: item.id,
      kind: item.kind,
      provider: item.provider,
      providerGameId: item.providerGameId,
      width: item.width,
      height: item.height,
      source: item.source,
      chosen: true,
      previewUrl: item.previewUrl,
      createdAt: item.createdAt
    }
  }
  return set
}

/** Regla central de preferencia manual. */
export function canAutoReplaceArtwork(current: ArtworkView | undefined): boolean {
  return !current || current.source !== 'manual'
}

/** No pisa una selección manual salvo que el usuario fuerce la sustitución. */
export function reconcileArtworkSelection(
  current: ArtworkView | undefined,
  incoming: ArtworkView,
  options: { force?: boolean } = {}
): ArtworkView {
  if (current && current.source === 'manual' && !options.force) {
    return { ...current, chosen: true }
  }
  return { ...incoming, chosen: true }
}

export function markManualArtwork(view: ArtworkView): ArtworkView {
  return { ...view, source: 'manual', chosen: true }
}

/** Mejor candidato de un tipo convertido a vista, sin persistir todavía. */
export function selectBestArtworkView(
  candidates: readonly ArtworkCandidate[],
  kind: ArtworkKind,
  options: { now?: Date; rank?: ArtworkRankOptions } = {}
): ArtworkView | null {
  const ranked = rankArtworkCandidates(candidates, kind, options.rank)
  const top = ranked[0]
  if (!top) return null
  const item = galleryItemFromCandidate(top.candidate, {
    selected: true,
    now: options.now ?? new Date()
  })
  return {
    id: item.id,
    kind: item.kind,
    provider: item.provider,
    providerGameId: item.providerGameId,
    width: item.width,
    height: item.height,
    source: item.source,
    chosen: true,
    previewUrl: item.previewUrl,
    createdAt: item.createdAt
  }
}
