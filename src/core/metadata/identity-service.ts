import type { GameMetadata, IdentityCandidate, IdentityState } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { Manifest } from '@shared/manifest'
import { evaluateIdentity, filterSafeCandidates, type CandidateScore } from './matching'
import type { MetadataService } from './service'
import type {
  IdentityResolution,
  MetadataLookup,
  ProviderCandidate,
  SearchHints
} from './types'

export interface IdentityInput {
  /** Título de búsqueda: searchTitle del manifiesto, nombre del catálogo o instalado. */
  query: string
  hints?: SearchHints
  signal?: AbortSignal
  forceRefresh?: boolean
}

export interface ConfirmIdentityOptions {
  now?: () => Date
  message?: string
}

export function identityCandidateFromProvider(candidate: ProviderCandidate): IdentityCandidate {
  return {
    key: candidate.key,
    provider: candidate.provider,
    providerId: candidate.providerId,
    title: candidate.title,
    releaseYear: candidate.releaseYear,
    edition: candidate.edition ?? null,
    previewUrl: candidate.previewUrl,
    verified: candidate.verified
  }
}

function stateFromRanked(
  ranked: CandidateScore[],
  options: {
    status: IdentityState['status']
    provider: string
    now: Date
    selected?: CandidateScore
    message?: string
    decidedBy?: IdentityState['decidedBy']
  }
): IdentityState {
  const selected = options.selected
  return {
    status: options.status,
    provider: selected?.candidate.provider ?? options.provider,
    providerId: selected?.candidate.providerId,
    title: selected?.candidate.title,
    releaseYear: selected?.candidate.releaseYear,
    decidedBy: options.decidedBy,
    candidates: ranked.map((entry) => identityCandidateFromProvider(entry.candidate)),
    updatedAt: options.now.toISOString(),
    message: options.message
  }
}

/**
 * Resolución de identidad contra un único proveedor. Nunca combina
 * candidatos de proveedores distintos y respeta los IDs fijados por el
 * manifiesto antes de hacer cualquier búsqueda.
 */
export class IdentityService {
  private readonly service: MetadataService
  private readonly now: () => Date

  constructor(options: { service: MetadataService; now?: () => Date }) {
    this.service = options.service
    this.now = options.now ?? (() => new Date())
  }

  get providerId(): string {
    return this.service.provider.info.id
  }

  async resolve(input: IdentityInput): Promise<IdentityResolution> {
    const now = this.now()
    const hints = input.hints ?? {}
    const fixedId = hints.providerIds?.[this.providerId]

    if (fixedId) {
      const candidate: ProviderCandidate = {
        key: `${this.providerId}:${fixedId}`,
        provider: this.providerId,
        providerId: fixedId,
        title: input.query.trim(),
        releaseYear: hints.releaseYear,
        edition: hints.edition ?? null,
        verified: true
      }
      const state: IdentityState = {
        status: 'confirmed',
        provider: this.providerId,
        providerId: fixedId,
        title: candidate.title,
        releaseYear: candidate.releaseYear,
        decidedBy: 'manifest',
        candidates: [identityCandidateFromProvider(candidate)],
        updatedAt: now.toISOString(),
        message: 'Identidad fijada por providerIds del manifiesto; no se buscó por título.'
      }
      return { state, selected: candidate, fromCache: false, stale: false }
    }

    if (hints.providerIds && Object.keys(hints.providerIds).length > 0) {
      const message =
        'El manifiesto fija identidad para otro proveedor. No se mezclan IDs ni resultados entre proveedores.'
      return {
        state: {
          status: 'none',
          provider: this.providerId,
          candidates: [],
          updatedAt: now.toISOString(),
          message
        },
        fromCache: false,
        stale: false,
        warning: message
      }
    }

    const query = input.query.trim()
    if (query.length === 0) {
      return {
        state: {
          status: 'none',
          provider: this.providerId,
          candidates: [],
          updatedAt: now.toISOString(),
          message: 'No hay título para buscar.'
        },
        fromCache: false,
        stale: false
      }
    }

    const lookedUp = await this.service.search(query, hints, {
      signal: input.signal,
      forceRefresh: input.forceRefresh
    })
    const fromCache = lookedUp.source === 'cache'

    if (!lookedUp.data || lookedUp.data.length === 0) {
      return {
        state: {
          status: 'none',
          provider: this.providerId,
          candidates: [],
          updatedAt: now.toISOString(),
          message:
            lookedUp.error?.message ??
            'El proveedor no devolvió resultados para este título.'
        },
        fromCache,
        stale: lookedUp.stale,
        error: lookedUp.error,
        warning: lookedUp.warning
      }
    }

    const safeCandidates = filterSafeCandidates(lookedUp.data)
    const evaluation = evaluateIdentity(query, hints, safeCandidates)
    const ranked = evaluation.ranked

    if (evaluation.decision === 'auto' && evaluation.selected) {
      return {
        state: stateFromRanked(ranked, {
          status: 'auto',
          provider: this.providerId,
          now,
          selected: evaluation.selected,
          decidedBy: 'auto',
          message: evaluation.reason
        }),
        selected: evaluation.selected.candidate,
        fromCache,
        stale: lookedUp.stale,
        error: lookedUp.error,
        warning: lookedUp.warning
      }
    }

    if (evaluation.decision === 'ambiguous') {
      return {
        state: stateFromRanked(ranked, {
          status: 'ambiguous',
          provider: this.providerId,
          now,
          message: evaluation.reason
        }),
        fromCache,
        stale: lookedUp.stale,
        error: lookedUp.error,
        warning: lookedUp.warning
      }
    }

    return {
      state: stateFromRanked(ranked, {
        status: 'none',
        provider: this.providerId,
        now,
        message: evaluation.reason
      }),
      fromCache,
      stale: lookedUp.stale,
      error: lookedUp.error,
      warning: lookedUp.warning
    }
  }

  /** Descarga el detalle del juego ya resuelto; no vuelve a buscar identidad. */
  async metadataFor(
    state: IdentityState,
    options: { signal?: AbortSignal; forceRefresh?: boolean } = {}
  ): Promise<MetadataLookup<GameMetadata>> {
    if ((state.status !== 'confirmed' && state.status !== 'auto') || !state.providerId) {
      return {
        data: null,
        source: 'none',
        stale: false,
        error: {
          code: 'METADATA_PROVIDER_FAILED',
          message: 'La identidad no está confirmada; no se solicitan metadatos.'
        }
      }
    }
    if (state.provider && state.provider !== this.providerId) {
      return {
        data: null,
        source: 'none',
        stale: false,
        error: {
          code: 'METADATA_PROVIDER_FAILED',
          message: 'La identidad pertenece a otro proveedor; no se mezclan identificadores.'
        }
      }
    }
    return this.service.getGame(state.providerId, options)
  }
}

function resolvedState(
  state: IdentityState,
  candidate: IdentityCandidate,
  now: Date,
  message?: string
): IdentityState {
  const candidates = state.candidates.some((entry) => entry.key === candidate.key)
    ? state.candidates
    : [...state.candidates, candidate]
  return {
    status: 'confirmed',
    provider: candidate.provider,
    providerId: candidate.providerId,
    title: candidate.title,
    releaseYear: candidate.releaseYear,
    decidedBy: 'user',
    candidates,
    updatedAt: now.toISOString(),
    message
  }
}

/** El usuario confirma un candidato, aunque la heurística hubiera dudado. */
export function confirmIdentity(
  state: IdentityState,
  candidate: IdentityCandidate,
  options: ConfirmIdentityOptions = {}
): IdentityState {
  if (!candidate.providerId.trim() || !candidate.provider.trim()) {
    throw new AppError('VALIDATION_ERROR', 'El candidato no tiene proveedor o identificador.')
  }
  const now = options.now?.() ?? new Date()
  return resolvedState(
    state,
    candidate,
    now,
    options.message ?? 'Identidad confirmada por el usuario.'
  )
}

/** Corrige una identidad previa (auto, manifiesto o confirmación anterior). */
export function correctIdentity(
  state: IdentityState,
  candidate: IdentityCandidate,
  options: ConfirmIdentityOptions = {}
): IdentityState {
  return confirmIdentity(state, candidate, {
    ...options,
    message: options.message ?? 'Identidad corregida por el usuario.'
  })
}

/**
 * El usuario decide seguir sin metadatos. Se conserva la lista de candidatos
 * para que pueda corregir después, pero se limpia la identidad seleccionada.
 */
export function continueWithoutMetadata(
  state: IdentityState,
  options: { now?: () => Date; message?: string } = {}
): IdentityState {
  const now = options.now?.() ?? new Date()
  return {
    status: 'none',
    provider: state.provider,
    candidates: state.candidates,
    updatedAt: now.toISOString(),
    message:
      options.message ??
      'El usuario eligió continuar sin metadatos. No se volverá a seleccionar automáticamente.'
  }
}

export function isIdentityResolved(state: IdentityState): boolean {
  return state.status === 'auto' || state.status === 'confirmed'
}

/** Construye las pistas de búsqueda a partir del manifiesto. */
export function hintsFromManifest(metadata: Manifest['metadata']): SearchHints {
  if (!metadata) return {}
  return {
    releaseYear: metadata.releaseYear,
    edition: metadata.edition ?? undefined,
    providerIds: metadata.providerIds
  }
}

/** Título preferente: searchTitle del manifiesto, luego el nombre visible. */
export function queryFromManifest(metadata: Manifest['metadata'], fallback: string): string {
  return metadata?.searchTitle?.trim() || fallback.trim()
}
