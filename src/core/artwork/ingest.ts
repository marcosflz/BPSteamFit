import type { ArtworkView } from '@shared/domain'
import { ARTWORK_KINDS } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { ArtworkCandidate } from '../metadata/types'
import { ControlledArtworkDownloader } from './download'
import {
  ARTWORK_DOWNLOAD_DEFAULTS,
  type ArtworkDownload,
  type ArtworkDownloader,
  type ArtworkIngestOptions,
  type ArtworkIngestorOptions,
  type ArtworkStorage,
  type ArtworkViewOptions,
  type IngestedArtwork
} from './types'
import { detectImage, renderArtworkVariant, sha256Bytes, type DetectedImage } from './variants'

function extensionFor(format: DetectedImage['format']): string {
  return format === 'jpeg' ? 'jpg' : format
}

/**
 * Ingesta de artwork: descarga controlada, validación del contenido real con
 * sharp, conservación del original, generación de UNA variante del tipo
 * solicitado y persistencia opcional mediante `ArtworkStorage`.
 */
export class ArtworkIngestor {
  readonly #downloader: ArtworkDownloader
  readonly #storage?: ArtworkStorage
  readonly #now: () => Date
  readonly #maxBytes: number
  readonly #maxPixels: number
  readonly #allowDataUrls: boolean

  constructor(options: ArtworkIngestorOptions = {}) {
    this.#now = options.now ?? (() => new Date())
    this.#maxBytes = options.maxBytes ?? ARTWORK_DOWNLOAD_DEFAULTS.maxBytes
    this.#maxPixels = options.maxPixels ?? ARTWORK_DOWNLOAD_DEFAULTS.maxPixels
    this.#allowDataUrls = options.allowDataUrls ?? true
    this.#storage = options.storage
    this.#downloader =
      options.downloader ??
      new ControlledArtworkDownloader({
        fetchImpl: options.fetchImpl,
        allowedHosts: options.allowedHosts,
        allowDataUrls: options.allowDataUrls,
        allowInsecureLocalhost: options.allowInsecureLocalhost,
        maxBytes: options.maxBytes
      })
  }

  async ingest(
    candidate: ArtworkCandidate,
    options: ArtworkIngestOptions = {}
  ): Promise<IngestedArtwork> {
    if (!ARTWORK_KINDS.includes(candidate.kind)) {
      throw new AppError('ARTWORK_INVALID', 'El tipo de artwork no es válido.', {
        details: { kind: candidate.kind }
      })
    }
    if (!candidate.url || candidate.url.trim().length === 0) {
      throw new AppError('ARTWORK_INVALID', 'El candidato de artwork no tiene URL.')
    }
    const maxBytes = options.maxBytes ?? this.#maxBytes
    const maxPixels = options.maxPixels ?? this.#maxPixels

    let downloaded: ArtworkDownload
    try {
      downloaded = await this.#downloader.download(candidate.url, {
        signal: options.signal,
        maxBytes,
        allowedHosts: options.allowedHosts,
        allowDataUrls: options.allowDataUrls ?? this.#allowDataUrls,
        allowInsecureLocalhost: options.allowInsecureLocalhost
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('ARTWORK_DOWNLOAD_FAILED', 'No se pudo descargar el artwork.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    if (downloaded.bytes.byteLength > maxBytes) {
      throw new AppError('ARTWORK_TOO_LARGE', 'La imagen supera el tamaño máximo permitido.', {
        details: { maxBytes }
      })
    }

    const detected = await detectImage(downloaded.bytes, { maxPixels })
    const originalSha = sha256Bytes(downloaded.bytes)
    const variant = await renderArtworkVariant(downloaded.bytes, candidate.kind, { maxPixels })

    let storageKeys: {
      original?: { key: string; url?: string }
      variant?: { key: string; url?: string }
    } = {}

    if (this.#storage) {
      try {
        const original = await this.#storage.put(
          `${originalSha}/original.${extensionFor(detected.format)}`,
          downloaded.bytes,
          {
            mime: detected.mime,
            width: detected.width,
            height: detected.height,
            sha256: originalSha,
            original: true
          }
        )
        const rendered = await this.#storage.put(
          `${originalSha}/${candidate.kind}.png`,
          variant.bytes,
          {
            mime: 'image/png',
            width: variant.width,
            height: variant.height,
            sha256: variant.sha256,
            original: false,
            kind: candidate.kind
          }
        )
        storageKeys = { original, variant: rendered }
      } catch (error) {
        throw new AppError('IO_ERROR', 'No se pudo guardar el artwork en el almacenamiento local.', {
          cause: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return {
      id: originalSha,
      provider: candidate.provider,
      providerGameId: candidate.providerGameId,
      candidate,
      original: {
        bytes: downloaded.bytes,
        byteLength: downloaded.bytes.byteLength,
        mime: detected.mime,
        format: detected.format,
        width: detected.width,
        height: detected.height,
        sha256: originalSha,
        storageKey: storageKeys.original?.key,
        url: storageKeys.original?.url
      },
      variant: {
        ...variant,
        storageKey: storageKeys.variant?.key,
        url: storageKeys.variant?.url
      },
      createdAt: this.#now().toISOString()
    }
  }
}

export function buildArtworkView(
  artwork: IngestedArtwork,
  options: ArtworkViewOptions
): ArtworkView {
  return {
    id: artwork.id,
    kind: artwork.variant.kind,
    provider: artwork.provider,
    providerGameId: artwork.providerGameId,
    width: artwork.variant.width,
    height: artwork.variant.height,
    source: options.source ?? 'provider',
    chosen: options.chosen ?? false,
    previewUrl: options.previewUrl,
    createdAt: artwork.createdAt
  }
}

/** Almacenamiento en memoria para tests; el coordinador aportará el suyo. */
export class MemoryArtworkStorage implements ArtworkStorage {
  private readonly blobs = new Map<string, { bytes: Uint8Array; mime: string }>()

  async put(
    key: string,
    bytes: Uint8Array,
    info: { mime: string; width: number; height: number; sha256: string; original: boolean }
  ): Promise<{ key: string }> {
    this.blobs.set(key, { bytes: new Uint8Array(bytes), mime: info.mime })
    return { key }
  }

  has(key: string): boolean {
    return this.blobs.has(key)
  }

  get(key: string): { bytes: Uint8Array; mime: string } | undefined {
    const value = this.blobs.get(key)
    return value ? { bytes: new Uint8Array(value.bytes), mime: value.mime } : undefined
  }

  get size(): number {
    return this.blobs.size
  }
}
