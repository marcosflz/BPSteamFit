import type { ProviderCandidate, SearchHints } from './types'
import {
  editionsEqual,
  normalizeTitle,
  parseTitle,
  sequelNumbersEqual,
  titleSimilarity,
  variantsEqual,
  type ParsedTitle
} from './normalization'

export const AUTO_SELECTION = {
  /** Puntuación heurística mínima para auto-seleccionar. */
  minScore: 82,
  /** Ventaja mínima sobre el segundo candidato. */
  minMargin: 15,
  /** Diferencia de año aceptada (los lanzamientos pueden cruzar de año). */
  maxYearDelta: 1,
  /** Límite de candidatos que se conservan en el estado. */
  maxCandidates: 20
} as const

export interface CandidateScore {
  candidate: ProviderCandidate
  /** Heurística 0..100; no es una probabilidad. */
  score: number
  titleSimilarity: number
  exactTitle: boolean
  yearCompatible: boolean
  editionCompatible: boolean
  variantCompatible: boolean
  sequelCompatible: boolean
  platformCompatible: boolean
  autoEligible: boolean
  notes: string[]
}

export type IdentityDecision = 'auto' | 'ambiguous' | 'none'

export interface IdentityEvaluation {
  decision: IdentityDecision
  ranked: CandidateScore[]
  selected?: CandidateScore
  margin: number
  reason: string
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function normalizeEditionHint(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function queryWithEdition(query: string, hints: SearchHints): ParsedTitle {
  const edition = normalizeEditionHint(hints.edition)
  const parsed = parseTitle(query)
  if (edition.length === 0) return parsed
  const alreadyPresent = parseTitle(edition).editions.every((tag) => parsed.editions.includes(tag))
  if (alreadyPresent) return parsed
  return parseTitle(`${query} ${edition}`)
}

function normalizePlatform(value: string): string {
  return normalizeTitle(value)
    .replace(/\b(?:pc|windows|win)\b/g, 'pc')
    .trim()
}

function platformCompatible(hint: string | undefined, platforms: string[] | undefined): {
  compatible: boolean
  note?: string
} {
  if (!hint || !platforms || platforms.length === 0) return { compatible: true }
  const wanted = normalizePlatform(hint)
  const available = platforms.map(normalizePlatform).filter((value) => value.length > 0)
  if (available.length === 0) return { compatible: true }
  const compatible = available.includes(wanted)
  return {
    compatible,
    note: compatible ? undefined : `La plataforma ${hint} no coincide con el candidato.`
  }
}

function yearCompatibility(
  queryYear: number | undefined,
  candidateYear: number | undefined
): boolean {
  if (queryYear === undefined) return true
  if (candidateYear === undefined) return false
  return Math.abs(queryYear - candidateYear) <= AUTO_SELECTION.maxYearDelta
}

function setCompatibility(
  left: string[],
  right: string[],
  label: string,
  notes: string[]
): boolean {
  const a = [...left].sort().join(',')
  const b = [...right].sort().join(',')
  if (a === b) return true
  notes.push(`No coincide la ${label} (${a || 'ninguna'} frente a ${b || 'ninguna'}).`)
  return false
}

/**
 * Puntuación determinista y explicable. La similitud de título es una
 * heurística de tokens/bigramas, nunca una probabilidad de coincidencia.
 */
export function scoreCandidate(
  query: string,
  hints: SearchHints,
  candidate: ProviderCandidate
): CandidateScore {
  const notes: string[] = []
  const queryTitle = queryWithEdition(query, hints)
  const candidateTitle = parseTitle(candidate.title)
  const similarity = titleSimilarity(queryTitle.normalized, candidateTitle.normalized)
  const exactTitle = queryTitle.normalized.length > 0 && queryTitle.normalized === candidateTitle.normalized
  const coreExact = queryTitle.core.length > 0 && queryTitle.core === candidateTitle.core

  let score = 0

  if (exactTitle) {
    score += 60
    notes.push('El título normalizado coincide exactamente.')
  } else {
    score += similarity * 52
    if (coreExact) score += 4
    if (similarity >= 0.55) {
      notes.push(`Similitud de título heurística ${(similarity * 100).toFixed(1)} %.`)
    } else {
      notes.push('El título es demasiado distinto.')
    }
  }

  const queryYear = hints.releaseYear
  const candidateYear = candidate.releaseYear
  const yearCompatible = yearCompatibility(queryYear, candidateYear)
  if (queryYear !== undefined && candidateYear !== undefined) {
    const delta = Math.abs(queryYear - candidateYear)
    if (delta === 0) score += 20
    else if (delta <= AUTO_SELECTION.maxYearDelta) score += 8
    else {
      score -= 30
      notes.push(`El año ${candidateYear} no es compatible con ${queryYear}.`)
    }
  } else if (queryYear !== undefined && candidateYear === undefined) {
    notes.push('El candidato no declara año; no se puede validar la coincidencia.')
  }

  const editionCompatible = editionsEqual(queryTitle, candidateTitle)
  if (editionCompatible) score += 10
  else {
    if (queryTitle.editions.length === 0) score -= 12
    else if (candidateTitle.editions.length === 0) score -= 6
    else score -= 18
    notes.push(
      `Edición distinta (${queryTitle.editions.join(', ') || 'base'} frente a ${candidateTitle.editions.join(', ') || 'base'}).`
    )
  }

  const variantCompatible = variantsEqual(queryTitle, candidateTitle)
  if (variantCompatible) score += 10
  else {
    score -= 35
    notes.push(
      `Variante distinta (${queryTitle.variants.join(', ') || 'original'} frente a ${candidateTitle.variants.join(', ') || 'original'}).`
    )
  }

  const sequelCompatible = sequelNumbersEqual(queryTitle, candidateTitle)
  if (sequelCompatible) score += 8
  else {
    score -= 30
    notes.push(
      `Número de secuela distinto (${queryTitle.sequelNumbers.join(', ') || 'ninguno'} frente a ${candidateTitle.sequelNumbers.join(', ') || 'ninguno'}).`
    )
  }

  const platform = platformCompatible(hints.platform, candidate.platforms)
  if (platform.note) notes.push(platform.note)
  if (platform.compatible && hints.platform && candidate.platforms && candidate.platforms.length > 0) {
    score += 6
  } else if (!platform.compatible) {
    score -= 12
  }

  if (candidate.verified) score += 2

  if (similarity < 0.55 && !exactTitle) score = Math.min(score, 49)

  const autoEligible =
    exactTitle &&
    editionCompatible &&
    variantCompatible &&
    sequelCompatible &&
    yearCompatible &&
    platform.compatible &&
    score >= AUTO_SELECTION.minScore

  return {
    candidate,
    score: roundScore(score),
    titleSimilarity: Math.round(similarity * 1000) / 1000,
    exactTitle,
    yearCompatible,
    editionCompatible,
    variantCompatible,
    sequelCompatible,
    platformCompatible: platform.compatible,
    autoEligible,
    notes
  }
}

function compareScores(left: CandidateScore, right: CandidateScore): number {
  if (right.score !== left.score) return right.score - left.score
  const leftYear = left.candidate.releaseYear ?? Number.MAX_SAFE_INTEGER
  const rightYear = right.candidate.releaseYear ?? Number.MAX_SAFE_INTEGER
  if (leftYear !== rightYear) return leftYear - rightYear
  return left.candidate.key.localeCompare(right.candidate.key)
}

export function rankCandidates(
  query: string,
  hints: SearchHints,
  candidates: readonly ProviderCandidate[]
): CandidateScore[] {
  return candidates
    .map((candidate) => scoreCandidate(query, hints, candidate))
    .sort(compareScores)
    .slice(0, AUTO_SELECTION.maxCandidates)
}

/**
 * Regla de auto-selección:
 * - coincidencia normalizada exacta del título completo;
 * - misma edición, variante y número de secuela;
 * - año compatible cuando la consulta lo aporta (si no lo aporta, el título
 *   exacto debe ser único);
 * - plataforma compatible si ambas partes la declaran;
 * - puntuación mínima y ventaja clara sobre el segundo candidato.
 * Cualquier otro caso queda como ambigüedad con candidatos.
 */
export function evaluateIdentity(
  query: string,
  hints: SearchHints,
  candidates: readonly ProviderCandidate[]
): IdentityEvaluation {
  if (candidates.length === 0) {
    return {
      decision: 'none',
      ranked: [],
      margin: 0,
      reason: 'El proveedor no devolvió candidatos.'
    }
  }

  const ranked = rankCandidates(query, hints, candidates)
  const top = ranked[0]
  if (!top) {
    return {
      decision: 'none',
      ranked,
      margin: 0,
      reason: 'El proveedor no devolvió candidatos utilizables.'
    }
  }
  const second = ranked[1]
  const margin = second ? roundScore(top.score - second.score) : 100

  if (!top.autoEligible) {
    return {
      decision: 'ambiguous',
      ranked,
      margin,
      reason: 'Ningún candidato cumple todas las reglas de auto-selección.'
    }
  }

  const queryTitle = queryWithEdition(query, hints)
  const exactAlternatives = ranked.filter(
    (entry) =>
      entry.exactTitle &&
      entry.editionCompatible &&
      entry.variantCompatible &&
      entry.sequelCompatible &&
      entry.yearCompatible &&
      entry.platformCompatible
  )
  if (queryTitle.normalized.length === 0) {
    return {
      decision: 'ambiguous',
      ranked,
      margin,
      reason: 'La consulta no tiene un título normalizable.'
    }
  }
  if (hints.releaseYear === undefined && exactAlternatives.length > 1) {
    return {
      decision: 'ambiguous',
      ranked,
      margin,
      reason: 'Hay varios títulos exactos y la consulta no aporta año para desempatar.'
    }
  }
  if (margin < AUTO_SELECTION.minMargin) {
    return {
      decision: 'ambiguous',
      ranked,
      margin,
      reason: `La ventaja (${margin.toFixed(1)} puntos) no alcanza el margen mínimo de ${AUTO_SELECTION.minMargin}.`
    }
  }

  return {
    decision: 'auto',
    ranked,
    selected: top,
    margin,
    reason: 'Título exacto, metadatos compatibles y ventaja suficiente.'
  }
}

/** Expone la consulta efectiva (título + edición del manifiesto). */
export function buildSearchQuery(title: string, hints: SearchHints): string {
  const edition = normalizeEditionHint(hints.edition)
  return edition.length > 0 ? `${title} ${edition}`.trim() : title.trim()
}

/** Descarta candidatos que el proveedor marque con contenido no apto. */
export function filterSafeCandidates(
  candidates: readonly ProviderCandidate[],
  options: { allowSensitive?: boolean } = {}
): ProviderCandidate[] {
  if (options.allowSensitive) return [...candidates]
  return candidates.filter((candidate) => {
    const tags = (candidate.tags ?? []).map((tag) => tag.toLocaleLowerCase('en-US'))
    return !tags.some((tag) => tag === 'nsfw' || tag === 'humor' || tag === 'epilepsy')
  })
}
