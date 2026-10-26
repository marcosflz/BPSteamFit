import type { ArtworkKind } from '@shared/domain'
import type { FetchLike, ArtworkCandidate } from '../metadata/types'

export const ARTWORK_DOWNLOAD_DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 15 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxRedirects: 3
} as const

/** Hosts HTTPS verificados de la CDN de SteamGridDB (consulta 2026-10-26). */
export const STEAMGRIDDB_ARTWORK_HOSTS = ['cdn.steamgriddb.com', 'cdn2.steamgriddb.com'] as const

export const ALLOWED_RASTER_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export interface ArtworkDownloadOptions {
  signal?: AbortSignal
  maxBytes?: number
  timeoutMs?: number
  allowedHosts?: readonly string[]
  /** Solo el proveedor mock usa data URLs; se validan como raster real. */
  allowDataUrls?: boolean
  /** Solo tests: permite HTTP contra loopback. */
  allowInsecureLocalhost?: boolean
  maxRedirects?: number
}

export interface ArtworkDownload {
  bytes: Uint8Array
  /** MIME declarado por el servidor o por el data URL; puede ser falso. */
  declaredMime?: string
  sourceUrl: string
  finalUrl: string
  fromDataUrl: boolean
}

export interface ArtworkDownloader {
  download(url: string, options?: ArtworkDownloadOptions): Promise<ArtworkDownload>
}

export interface ArtworkStorageInfo {
  mime: string
  width: number
  height: number
  sha256: string
  original: boolean
  kind?: ArtworkKind
}

export interface StoredArtworkBlob {
  key: string
  /** URL opcional que el coordinador puede exponer por un protocolo seguro. */
  url?: string
}

/**
 * Persistencia inyectable. El coordinador la implementará con archivos en
 * `userData`/artwork y SQLite; este módulo conserva siempre el original y
 * entrega las variantes generadas.
 */
export interface ArtworkStorage {
  put(key: string, bytes: Uint8Array, info: ArtworkStorageInfo): Promise<StoredArtworkBlob>
}

export interface ArtworkOriginal {
  bytes: Uint8Array
  byteLength: number
  mime: string
  format: 'png' | 'jpeg' | 'webp'
  width: number
  height: number
  sha256: string
  storageKey?: string
  url?: string
}

export interface ArtworkVariant {
  kind: ArtworkKind
  bytes: Uint8Array
  byteLength: number
  mime: 'image/png'
  width: number
  height: number
  sha256: string
  storageKey?: string
  url?: string
}

export interface IngestedArtwork {
  id: string
  provider: string
  providerGameId: string
  candidate: ArtworkCandidate
  original: ArtworkOriginal
  variant: ArtworkVariant
  createdAt: string
}

export interface ArtworkIngestOptions {
  signal?: AbortSignal
  maxBytes?: number
  maxPixels?: number
  allowedHosts?: readonly string[]
  allowDataUrls?: boolean
  allowInsecureLocalhost?: boolean
}

export interface ArtworkIngestorOptions {
  downloader?: ArtworkDownloader
  storage?: ArtworkStorage
  fetchImpl?: FetchLike
  now?: () => Date
  maxBytes?: number
  maxPixels?: number
  allowedHosts?: readonly string[]
  allowDataUrls?: boolean
  allowInsecureLocalhost?: boolean
}

export interface PlaceholderOptions {
  title: string
  kind: ArtworkKind
  /** Se ignoran si el tipo tiene un tamaño canónico. */
  width?: number
  height?: number
  initials?: string
}

export interface PlaceholderArtwork {
  kind: ArtworkKind
  bytes: Uint8Array
  mime: 'image/png'
  width: number
  height: number
  initials: string
}

export interface ArtworkViewOptions {
  previewUrl: string
  source?: 'provider' | 'manual'
  chosen?: boolean
}

export const ARTWORK_TARGET_DIMENSIONS: Readonly<
  Record<Exclude<ArtworkKind, 'logo'>, { width: number; height: number }>
> = {
  portrait: { width: 600, height: 900 },
  hero: { width: 1920, height: 620 },
  icon: { width: 256, height: 256 },
  screenshot: { width: 1920, height: 1080 }
}
