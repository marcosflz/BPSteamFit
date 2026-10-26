import type { ArtworkKind } from '@shared/domain'
import { ARTWORK_TARGET_DIMENSIONS } from './types'
import type { ArtworkCandidate } from '../metadata/types'
import { aspectTolerance, isAspectCompatible } from './variants'

export interface ArtworkRankOptions {
  allowSensitive?: boolean
  preferredStyle?: string
  /** Penaliza imágenes por debajo del tamaño objetivo; no las descarta. */
  preferLarge?: boolean
}

export interface RankedArtwork {
  candidate: ArtworkCandidate
  /** Heurística 0..100 determinista, no una probabilidad. */
  score: number
  aspectCompatible: boolean
  notes: string[]
}

function tagsAreSafe(tags: string[] | undefined): boolean {
  if (!tags) return true
  const normalized = tags.map((tag) => tag.toLocaleLowerCase('en-US'))
  return !normalized.some((tag) => tag === 'nsfw' || tag === 'humor' || tag === 'epilepsy')
}

function styleScore(kind: ArtworkKind, style: string | undefined): number {
  if (!style) return 0
  const normalized = style.toLocaleLowerCase('en-US')
  if (kind === 'logo' && normalized.includes('official')) return 10
  if (kind === 'icon' && normalized.includes('official')) return 8
  if (kind === 'hero' && normalized.includes('alternate')) return 5
  if (normalized.includes('material')) return 4
  if (normalized.includes('custom') || normalized.includes('demo')) return 3
  return 1
}

function aspectScore(kind: ArtworkKind, width?: number, height?: number): number {
  if (!width || !height) return 0
  const target = kind === 'logo' ? null : ARTWORK_TARGET_DIMENSIONS[kind as Exclude<ArtworkKind, 'logo'>]
  if (!target) return 20
  const targetRatio = target.width / target.height
  const ratio = width / height
  const tolerance = aspectTolerance(kind)
  const closeness = Math.max(0, 1 - Math.abs(ratio - targetRatio) / targetRatio / tolerance)
  return closeness * 55
}

function resolutionScore(kind: ArtworkKind, width?: number, height?: number): number {
  if (!width || !height) return 0
  if (kind === 'logo') {
    const scale = Math.min(width / 1000, height / 400)
    return Math.min(1.5, scale) * 18
  }
  const target = ARTWORK_TARGET_DIMENSIONS[kind]
  const scale = Math.min(width / target.width, height / target.height)
  return Math.min(1.5, Math.max(0, scale)) * 30
}

/**
 * Puntuación de selección por tipo y relación de aspecto. Un candidato con
 * dimensiones de retrato nunca es compatible con `hero`, aunque el proveedor
 * lo etiquete mal. Los candidatos de tipo distinto se descartan siempre.
 */
export function scoreArtworkForKind(
  candidate: ArtworkCandidate,
  kind: ArtworkKind,
  options: ArtworkRankOptions = {}
): RankedArtwork | null {
  if (candidate.kind !== kind) return null
  if (!options.allowSensitive && !tagsAreSafe(candidate.tags)) return null

  const dimensioned = Boolean(candidate.width && candidate.height)
  const aspectCompatible = dimensioned
    ? isAspectCompatible(kind, candidate.width, candidate.height)
    : false

  if (kind !== 'logo' && !aspectCompatible) return null

  let score = 0
  const notes: string[] = []
  if (dimensioned) {
    score += aspectScore(kind, candidate.width, candidate.height)
    score += resolutionScore(kind, candidate.width, candidate.height)
  } else {
    notes.push('El candidato no declara dimensiones; se puntúa por debajo de los medidos.')
  }
  score += styleScore(kind, candidate.style)
  if (
    options.preferredStyle &&
    candidate.style?.toLocaleLowerCase('en-US').includes(options.preferredStyle.toLocaleLowerCase('en-US'))
  ) {
    score += 6
  }
  if (candidate.isMock) score += 4
  if (candidate.attribution) score += 1
  if (options.preferLarge === false && dimensioned && candidate.width! * candidate.height! > 4_000_000) {
    score -= 3
  }

  return {
    candidate,
    score: Math.round(Math.max(0, Math.min(100, score)) * 100) / 100,
    aspectCompatible,
    notes
  }
}

function compareRanked(left: RankedArtwork, right: RankedArtwork): number {
  if (right.score !== left.score) return right.score - left.score
  const leftPixels = (left.candidate.width ?? 0) * (left.candidate.height ?? 0)
  const rightPixels = (right.candidate.width ?? 0) * (right.candidate.height ?? 0)
  if (rightPixels !== leftPixels) return rightPixels - leftPixels
  return left.candidate.providerAssetId.localeCompare(right.candidate.providerAssetId)
}

export function rankArtworkCandidates(
  candidates: readonly ArtworkCandidate[],
  kind?: ArtworkKind,
  options: ArtworkRankOptions = {}
): RankedArtwork[] {
  const ranked: RankedArtwork[] = []
  for (const candidate of candidates) {
    if (kind && candidate.kind !== kind) continue
    const score = scoreArtworkForKind(candidate, candidate.kind, options)
    if (score) ranked.push(score)
  }
  return ranked.sort(compareRanked)
}

/** Mejor candidato determinista; null si ninguno cumple tipo y aspecto. */
export function selectArtworkCandidate(
  candidates: readonly ArtworkCandidate[],
  kind: ArtworkKind,
  options: ArtworkRankOptions = {}
): RankedArtwork | null {
  return rankArtworkCandidates(candidates, kind, options)[0] ?? null
}
