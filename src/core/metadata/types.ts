import type {
  ArtworkKind,
  GameMetadata,
  IdentityCandidate,
  IdentityState,
  ProviderStatus
} from '@shared/domain'
import type { SerializedAppError } from '@shared/errors'

/**
 * Tipo mínimo de `fetch` que se inyecta en los proveedores y en la descarga de
 * artwork. En producción se usa el `fetch` global de Node/Electron; en tests se
 * usa un doble o el servidor HTTP local de fixtures.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export type MetadataLanguage = 'es' | 'en'

export interface ProviderCapabilities {
  /** Búsqueda de identidad y detalle de juego. */
  identity: boolean
  details: boolean
  /** Tipos de artwork que el proveedor puede listar. */
  artworkKinds: readonly ArtworkKind[]
  /** Descripciones editoriales reales; SGDB no las ofrece. */
  descriptions: boolean
  developers: boolean
  publishers: boolean
  releaseYear: boolean
  screenshots: boolean
}

export interface MetadataProviderInfo {
  id: string
  name: string
  requiresKey: boolean
  capabilities: ProviderCapabilities
  description: string
  attribution: string
}

export interface SearchHints {
  releaseYear?: number
  edition?: string | null
  platform?: string
  /** IDs ya confirmados en el manifiesto, por proveedor. */
  providerIds?: Readonly<Record<string, string>>
}

export interface ProviderCandidate extends IdentityCandidate {
  /** Plataformas declaradas por el proveedor, si las hay. */
  platforms?: string[]
  /** Etiquetas de contenido del proveedor; se usa para filtros seguros. */
  tags?: string[]
  /** Indica que el candidato pertenece a un fixture local. */
  isMock?: boolean
}

export interface ArtworkCandidate {
  provider: string
  providerAssetId: string
  providerGameId: string
  kind: ArtworkKind
  /** Procedencia del candidato: proveedor real, mock local o selección manual. */
  origin?: 'provider' | 'manual' | 'mock'
  /** URL HTTPS de la CDN del proveedor o `data:` en el proveedor mock. */
  url: string
  thumbUrl?: string
  width?: number
  height?: number
  mime?: string
  style?: string
  language?: string
  author?: string
  /** Texto visible de atribución, cuando el proveedor lo permite. */
  attribution?: string
  /** Licencia concreta del asset. SGDB no la expone; no se inventa. */
  license?: string
  tags?: string[]
  createdAt?: string
  isMock?: boolean
}

export interface ListArtworkOptions {
  signal?: AbortSignal
  /** Límite de seguridad, nunca superior a 50 por la API de SGDB. */
  limit?: number
}

/**
 * Contrato común de identidad y metadatos. Cada proveedor se usa de forma
 * aislada: la resolución nunca mezcla candidatos de proveedores distintos.
 */
export interface MetadataProvider {
  readonly info: MetadataProviderInfo
  /** true si tiene todo lo necesario para operar (por ejemplo, una clave). */
  isConfigured(): boolean
  searchCandidates(
    query: string,
    hints: SearchHints,
    signal?: AbortSignal
  ): Promise<ProviderCandidate[]>
  getGame(providerId: string, options?: { signal?: AbortSignal }): Promise<GameMetadata>
  listArtwork(
    providerGameId: string,
    kind: ArtworkKind,
    options?: ListArtworkOptions
  ): Promise<ArtworkCandidate[]>
}

export type MetadataLookupSource = 'provider' | 'cache' | 'none'

export interface MetadataLookup<T> {
  data: T | null
  source: MetadataLookupSource
  /** true si el dato servido desde caché ya había expirado. */
  stale: boolean
  cachedAt?: string
  error?: SerializedAppError
  warning?: string
}

export interface IdentityResolution {
  state: IdentityState
  /** Candidato elegido (auto o fijado por manifiesto); no se persiste aparte. */
  selected?: ProviderCandidate
  fromCache: boolean
  stale: boolean
  error?: SerializedAppError
  warning?: string
}

export interface MetadataCacheRecord {
  key: string
  /** Valor serializable; el coordinador lo guarda como JSON en SQLite. */
  value: unknown
  provider: string
  createdAt: string
  expiresAt: string
}

/**
 * Caché inyectable. Debe devolver también registros expirados para que el
 * servicio pueda usarlos como respaldo si el proveedor no responde. La
 * implementación de SQLite la aporta el coordinador.
 */
export interface MetadataCache {
  get(key: string): Promise<MetadataCacheRecord | null>
  set(record: MetadataCacheRecord): Promise<void>
  delete(key: string): Promise<void>
}

export interface ProviderStatusOptions {
  configured?: boolean
  offline?: boolean
}

export type ProviderRuntimeState = 'available' | 'not_configured' | 'offline'

export function providerRuntimeState(
  provider: MetadataProvider,
  options: ProviderStatusOptions = {}
): ProviderRuntimeState {
  if (options.offline) return 'offline'
  return provider.isConfigured() ? 'available' : 'not_configured'
}

/** `ProviderStatus` compartido; útil para el bootstrap de la aplicación. */
export function providerStatus(
  provider: MetadataProvider,
  options: ProviderStatusOptions = {}
): ProviderStatus {
  const isMock = provider.info.id === 'mock'
  const configured = options.configured ?? (isMock ? false : provider.isConfigured())
  return {
    mock: {
      available: true,
      description: 'Proveedor local de demostración: no usa red y sus datos están marcados como ficticios.'
    },
    steamgriddb: {
      configured,
      available: !options.offline && configured,
      description: isMock
        ? 'Proveedor opcional de identidad y arte de la comunidad. No ofrece descripciones, compañías ni capturas.'
        : provider.info.description,
      attribution: STEAMGRIDDB_ATTRIBUTION
    }
  }
}

export const MOCK_ATTRIBUTION =
  'Datos y arte de demostración originales de BPSteamFit; no son material oficial de ningún juego.'

export const STEAMGRIDDB_ATTRIBUTION =
  'Arte de la comunidad publicado en SteamGridDB; los derechos pertenecen a sus autores. SteamGridDB no está afiliado a Valve.'
