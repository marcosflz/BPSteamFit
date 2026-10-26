import type { ArtworkKind, GameMetadata, ProviderStatus } from '@shared/domain'
import { AppError, toAppError, type SerializedAppError } from '@shared/errors'
import { buildCacheKey, isCacheExpired, makeCacheRecord } from './cache'
import type {
  ArtworkCandidate,
  ListArtworkOptions,
  MetadataCache,
  MetadataCacheRecord,
  MetadataLanguage,
  MetadataLookup,
  MetadataProvider,
  ProviderCandidate,
  SearchHints
} from './types'
import { providerStatus } from './types'

export const DEFAULT_CACHE_TTL_MS = {
  search: 24 * 60 * 60 * 1000,
  details: 7 * 24 * 60 * 60 * 1000,
  artwork: 12 * 60 * 60 * 1000
} as const

export interface MetadataServiceOptions {
  provider: MetadataProvider
  cache?: MetadataCache
  offline?: boolean
  now?: () => Date
  language?: MetadataLanguage
  searchTtlMs?: number
  detailsTtlMs?: number
  artworkTtlMs?: number
}

export interface LookupOptions {
  signal?: AbortSignal
  forceRefresh?: boolean
}

interface LookupConfig<T> {
  key: string
  ttlMs: number
  /** Valida que un registro de caché tenga la forma esperada. */
  validate(value: unknown): value is T
  load(signal?: AbortSignal): Promise<T>
}

interface PreparedCache<T> {
  record: MetadataCacheRecord | null
  value: T | null
  fresh: boolean
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProviderCandidate(value: unknown): value is ProviderCandidate {
  if (!isRecord(value)) return false
  return (
    typeof value.key === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.title === 'string' &&
    value.title.length > 0
  )
}

function isCandidateArray(value: unknown): value is ProviderCandidate[] {
  return Array.isArray(value) && value.every(isProviderCandidate)
}

function isGameMetadata(value: unknown): value is GameMetadata {
  if (!isRecord(value)) return false
  return (
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    typeof value.provider === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.fetchedAt === 'string' &&
    typeof value.isMock === 'boolean'
  )
}

function isArtworkCandidate(value: unknown): value is ArtworkCandidate {
  if (!isRecord(value)) return false
  return (
    typeof value.provider === 'string' &&
    typeof value.providerAssetId === 'string' &&
    typeof value.providerGameId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.url === 'string' &&
    value.url.length > 0
  )
}

function isArtworkArray(value: unknown, kind: ArtworkKind): value is ArtworkCandidate[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isArtworkCandidate(entry) && entry.kind === kind)
  )
}

function warningForError(error: unknown): string {
  const appError = toAppError(error, 'METADATA_PROVIDER_FAILED')
  return `No se pudo actualizar el proveedor: ${appError.message}`
}

function serialize(error: unknown, fallbackMessage: string): SerializedAppError {
  return toAppError(error, 'METADATA_PROVIDER_FAILED', fallbackMessage).toJSON()
}

/**
 * Orquesta proveedor + caché. Ningún fallo de red o de caché debe impedir
 * abrir o instalar un juego: se devuelve un resultado con `error` o datos
 * obsoletos en lugar de lanzar desde los métodos de consulta.
 */
export class MetadataService {
  readonly provider: MetadataProvider
  private readonly cache?: MetadataCache
  private readonly now: () => Date
  private readonly language: MetadataLanguage
  private readonly searchTtlMs: number
  private readonly detailsTtlMs: number
  private readonly artworkTtlMs: number
  private offline: boolean

  constructor(options: MetadataServiceOptions) {
    this.provider = options.provider
    this.cache = options.cache
    this.now = options.now ?? (() => new Date())
    this.language = options.language ?? 'es'
    this.offline = options.offline ?? false
    this.searchTtlMs = options.searchTtlMs ?? DEFAULT_CACHE_TTL_MS.search
    this.detailsTtlMs = options.detailsTtlMs ?? DEFAULT_CACHE_TTL_MS.details
    this.artworkTtlMs = options.artworkTtlMs ?? DEFAULT_CACHE_TTL_MS.artwork
  }

  setOffline(offline: boolean): void {
    this.offline = offline
  }

  isOffline(): boolean {
    return this.offline
  }

  getStatus(options: { offline?: boolean } = {}): ProviderStatus {
    return providerStatus(this.provider, {
      offline: options.offline ?? this.offline
    })
  }

  async search(
    query: string,
    hints: SearchHints = {},
    options: LookupOptions = {}
  ): Promise<MetadataLookup<ProviderCandidate[]>> {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return { data: [], source: 'none', stale: false }
    }
    const key = buildCacheKey(this.provider.info.id, 'search', {
      query: trimmed,
      hints,
      language: this.language
    })
    return this.lookup<ProviderCandidate[]>(
      {
        key,
        ttlMs: this.searchTtlMs,
        validate: isCandidateArray,
        load: (signal) => this.provider.searchCandidates(trimmed, hints, signal)
      },
      options
    )
  }

  async getGame(
    providerId: string,
    options: LookupOptions = {}
  ): Promise<MetadataLookup<GameMetadata>> {
    const trimmed = providerId.trim()
    if (trimmed.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'El identificador del proveedor no puede estar vacío.')
    }
    const key = buildCacheKey(this.provider.info.id, 'game', {
      providerId: trimmed,
      language: this.language
    })
    return this.lookup<GameMetadata>(
      {
        key,
        ttlMs: this.detailsTtlMs,
        validate: isGameMetadata,
        load: (signal) => this.provider.getGame(trimmed, { signal })
      },
      options
    )
  }

  async listArtwork(
    providerGameId: string,
    kind: ArtworkKind,
    options: LookupOptions & ListArtworkOptions = {}
  ): Promise<MetadataLookup<ArtworkCandidate[]>> {
    const trimmed = providerGameId.trim()
    if (trimmed.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'El identificador del proveedor no puede estar vacío.')
    }
    const key = buildCacheKey(this.provider.info.id, `artwork:${kind}`, {
      providerGameId: trimmed,
      language: this.language,
      limit: options.limit
    })
    return this.lookup<ArtworkCandidate[]>(
      {
        key,
        ttlMs: this.artworkTtlMs,
        validate: (value): value is ArtworkCandidate[] => isArtworkArray(value, kind),
        load: (signal) =>
          this.provider.listArtwork(trimmed, kind, { signal, limit: options.limit })
      },
      options
    )
  }

  private async readCache<T>(
    key: string,
    validate: (value: unknown) => value is T,
    warnings: string[]
  ): Promise<PreparedCache<T>> {
    if (!this.cache) return { record: null, value: null, fresh: false }
    try {
      const record = await this.cache.get(key)
      if (!record) return { record: null, value: null, fresh: false }
      if (record.provider !== this.provider.info.id || !validate(record.value)) {
        warnings.push('Se ignoró un registro de caché con formato o proveedor inesperado.')
        return { record: null, value: null, fresh: false }
      }
      return {
        record,
        value: record.value,
        fresh: !isCacheExpired(record, this.now())
      }
    } catch {
      warnings.push('No se pudo leer la caché; se continúa sin ella.')
      return { record: null, value: null, fresh: false }
    }
  }

  private async writeCache(record: MetadataCacheRecord): Promise<string | undefined> {
    if (!this.cache) return undefined
    try {
      await this.cache.set(record)
      return undefined
    } catch {
      return 'No se pudo guardar el resultado en la caché.'
    }
  }

  private cachedLookup<T>(
    prepared: PreparedCache<T>,
    error: SerializedAppError,
    warning: string
  ): MetadataLookup<T> {
    return {
      data: prepared.value,
      source: 'cache',
      stale: true,
      cachedAt: prepared.record?.createdAt,
      error,
      warning: [warning, prepared.record ? 'Se muestran datos guardados de una consulta anterior.' : undefined]
        .filter((entry): entry is string => Boolean(entry))
        .join(' ')
    }
  }

  private async lookup<T>(
    config: LookupConfig<T>,
    options: LookupOptions
  ): Promise<MetadataLookup<T>> {
    const warnings: string[] = []
    const prepared = await this.readCache(config.key, config.validate, warnings)

    if (!options.forceRefresh && prepared.fresh && prepared.value !== null) {
      return {
        data: prepared.value,
        source: 'cache',
        stale: false,
        cachedAt: prepared.record?.createdAt,
        warning: warnings.length > 0 ? warnings.join(' ') : undefined
      }
    }

    if (this.offline) {
      if (prepared.value !== null) {
        warnings.push('Modo offline: se usan datos guardados; no se consultó al proveedor.')
        return {
          data: prepared.value,
          source: 'cache',
          stale: !prepared.fresh,
          cachedAt: prepared.record?.createdAt,
          warning: warnings.join(' ')
        }
      }
      warnings.push('Modo offline: no hay datos guardados para esta consulta.')
      return {
        data: null,
        source: 'none',
        stale: false,
        error: {
          code: 'METADATA_OFFLINE',
          message: 'No hay conexión y esta consulta no está en la caché local.'
        },
        warning: warnings.join(' ')
      }
    }

    if (!this.provider.isConfigured()) {
      const error: SerializedAppError = {
        code: 'METADATA_AUTH_REQUIRED',
        message: 'El proveedor de metadatos no está configurado. Puedes seguir usando el modo de demostración.'
      }
      if (prepared.value !== null) {
        return this.cachedLookup(prepared, error, warnings.join(' '))
      }
      warnings.push(error.message)
      return { data: null, source: 'none', stale: false, error, warning: warnings.join(' ') }
    }

    try {
      const data = await config.load(options.signal)
      const writeWarning = await this.writeCache(
        makeCacheRecord(config.key, this.provider.info.id, data, {
          now: this.now(),
          ttlMs: config.ttlMs
        })
      )
      if (writeWarning) warnings.push(writeWarning)
      return {
        data,
        source: 'provider',
        stale: false,
        cachedAt: this.now().toISOString(),
        warning: warnings.length > 0 ? warnings.join(' ') : undefined
      }
    } catch (error) {
      const serialized = serialize(error, 'El proveedor de metadatos no respondió correctamente.')
      if (prepared.value !== null) {
        return this.cachedLookup(prepared, serialized, warningForError(error))
      }
      warnings.push(serialized.message)
      if (warnings.length > 0) {
        return {
          data: null,
          source: 'none',
          stale: false,
          error: serialized,
          warning: warnings.join(' ')
        }
      }
      return { data: null, source: 'none', stale: false, error: serialized }
    }
  }
}
