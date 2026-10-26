import { AppError } from '@shared/errors'
import type { FetchLike } from '../metadata/types'
import {
  ALLOWED_RASTER_MIME_TYPES,
  ARTWORK_DOWNLOAD_DEFAULTS,
  STEAMGRIDDB_ARTWORK_HOSTS,
  type ArtworkDownload,
  type ArtworkDownloadOptions,
  type ArtworkDownloader
} from './types'

const ALLOWED_MIME = new Set<string>(ALLOWED_RASTER_MIME_TYPES)

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase('en-US')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

function contentType(value: string | null): string | undefined {
  if (!value) return undefined
  const normalized = value.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US')
  return normalized || undefined
}

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('ARTWORK_INVALID', message, { details })
}

function downloadFailed(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('ARTWORK_DOWNLOAD_FAILED', message, { details })
}

function tooLarge(maxBytes: number): AppError {
  return new AppError('ARTWORK_TOO_LARGE', 'La imagen supera el tamaño máximo permitido.', {
    details: { maxBytes }
  })
}

function abortFailure(reason: 'aborted' | 'timeout' | 'network'): AppError {
  const message =
    reason === 'timeout'
      ? 'La descarga de la imagen superó el tiempo máximo.'
      : reason === 'aborted'
        ? 'La descarga de la imagen se canceló.'
        : 'No se pudo conectar con la CDN del artwork.'
  return downloadFailed(message, { reason })
}

/** Comprueba protocolo, host permitido y ausencia de credenciales en la URL. */
export function isAllowedArtworkUrl(
  raw: string,
  options: {
    allowedHosts?: readonly string[]
    allowInsecureLocalhost?: boolean
  } = {}
): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') {
    const hosts = new Set((options.allowedHosts ?? STEAMGRIDDB_ARTWORK_HOSTS).map((host) => host.toLocaleLowerCase('en-US')))
    return hosts.has(url.hostname.toLocaleLowerCase('en-US'))
  }
  if (url.protocol === 'http:' && options.allowInsecureLocalhost === true && isLoopback(url.hostname)) {
    return true
  }
  return false
}

function decodeDataUrl(raw: string, maxBytes: number): ArtworkDownload {
  const comma = raw.indexOf(',')
  if (comma < 5) throw invalid('El data URL de imagen no tiene el formato esperado.')
  const metadata = raw.slice(5, comma)
  const parts = metadata.split(';')
  const mime = parts[0]?.trim().toLocaleLowerCase('en-US') ?? ''
  const isBase64 = parts.slice(1).some((part) => part.trim().toLocaleLowerCase('en-US') === 'base64')
  if (!isBase64) {
    throw invalid('Solo se admiten data URLs de imagen codificados en base64.')
  }
  if (mime === 'image/svg+xml') {
    throw invalid('Los SVG no se aceptan como descarga de artwork, ni siquiera en data URLs.', {
      reason: 'svg_not_allowed'
    })
  }
  if (!ALLOWED_MIME.has(mime)) {
    throw invalid('El data URL declara un tipo de imagen no permitido.', { declaredMime: mime })
  }

  const encoded = raw
    .slice(comma + 1)
    .replace(/\s+/g, '')
  if (encoded.length === 0) throw invalid('El data URL no contiene bytes.')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw invalid('El contenido base64 del data URL no es válido.')
  }
  const estimated = Math.floor((encoded.length * 3) / 4)
  if (estimated > maxBytes) throw tooLarge(maxBytes)
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'))
  if (bytes.byteLength === 0) throw invalid('El data URL no contiene una imagen.')
  if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes)
  return {
    bytes,
    declaredMime: mime,
    sourceUrl: 'data:image',
    finalUrl: 'data:image',
    fromDataUrl: true
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    if (Number.parseInt(contentLength, 10) > maxBytes) {
      try {
        await response.body?.cancel()
      } catch {
        // ignorado
      }
      throw tooLarge(maxBytes)
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw tooLarge(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Descarga controlada de artwork: solo HTTPS contra una lista blanca de hosts,
 * redirecciones revalidadas, timeout, tamaño máximo y MIME declarado raster.
 * La validación del contenido real la hace `ArtworkIngestor` con sharp.
 */
export class ControlledArtworkDownloader implements ArtworkDownloader {
  private readonly fetchImpl: FetchLike
  private readonly allowedHosts: readonly string[]
  private readonly allowDataUrls: boolean
  private readonly allowInsecureLocalhost: boolean
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly maxRedirects: number

  constructor(
    options: {
      fetchImpl?: FetchLike
      allowedHosts?: readonly string[]
      allowDataUrls?: boolean
      allowInsecureLocalhost?: boolean
      timeoutMs?: number
      maxBytes?: number
      maxRedirects?: number
    } = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.allowedHosts = options.allowedHosts ?? STEAMGRIDDB_ARTWORK_HOSTS
    this.allowDataUrls = options.allowDataUrls ?? true
    this.allowInsecureLocalhost = options.allowInsecureLocalhost ?? false
    this.timeoutMs = options.timeoutMs ?? ARTWORK_DOWNLOAD_DEFAULTS.timeoutMs
    this.maxBytes = options.maxBytes ?? ARTWORK_DOWNLOAD_DEFAULTS.maxBytes
    this.maxRedirects = options.maxRedirects ?? ARTWORK_DOWNLOAD_DEFAULTS.maxRedirects
  }

  async download(url: string, options: ArtworkDownloadOptions = {}): Promise<ArtworkDownload> {
    const maxBytes = options.maxBytes ?? this.maxBytes
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const maxRedirects = options.maxRedirects ?? this.maxRedirects
    const allowedHosts = options.allowedHosts ?? this.allowedHosts
    const allowDataUrls = options.allowDataUrls ?? this.allowDataUrls
    const allowInsecureLocalhost = options.allowInsecureLocalhost ?? this.allowInsecureLocalhost

    if (url.startsWith('data:')) {
      if (!allowDataUrls) {
        throw invalid('Este contexto no permite data URLs para artwork.')
      }
      return decodeDataUrl(url, maxBytes)
    }

    if (
      !isAllowedArtworkUrl(url, {
        allowedHosts,
        allowInsecureLocalhost
      })
    ) {
      throw invalid('El origen del artwork no está permitido.', { reason: 'origin_not_allowed' })
    }

    if (options.signal?.aborted) throw abortFailure('aborted')
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const externalAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', externalAbort, { once: true })

    try {
      let currentUrl = url
      for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        if (options.signal?.aborted) throw abortFailure('aborted')
        if (
          !isAllowedArtworkUrl(currentUrl, {
            allowedHosts,
            allowInsecureLocalhost
          })
        ) {
          throw invalid('La redirección del artwork apunta a un origen no permitido.', {
            reason: 'redirect_origin_not_allowed'
          })
        }

        let response: Response
        try {
          response = await this.fetchImpl(currentUrl, {
            method: 'GET',
            headers: {
              Accept: 'image/png,image/jpeg,image/webp;q=0.9',
              'User-Agent': 'BPSteamFit/0.1 (artwork)'
            },
            redirect: 'manual',
            signal: controller.signal
          })
        } catch {
          if (options.signal?.aborted) throw abortFailure('aborted')
          throw abortFailure(timedOut ? 'timeout' : 'network')
        }

        if (response.status >= 300 && response.status <= 399) {
          const location = response.headers.get('location')
          try {
            await response.body?.cancel()
          } catch {
            // ignorado
          }
          if (!location) {
            throw downloadFailed('La redirección de la imagen no incluye Location.', {
              status: response.status
            })
          }
          if (redirects === maxRedirects) {
            throw downloadFailed('La imagen supera el número máximo de redirecciones.', {
              maxRedirects
            })
          }
          try {
            currentUrl = new URL(location, currentUrl).toString()
          } catch {
            throw downloadFailed('La redirección de la imagen no es una URL válida.', {
              status: response.status
            })
          }
          continue
        }

        if (
          response.url &&
          !isAllowedArtworkUrl(response.url, {
            allowedHosts,
            allowInsecureLocalhost
          })
        ) {
          try {
            await response.body?.cancel()
          } catch {
            // ignorado
          }
          throw invalid('La descarga terminó en un origen no permitido.', {
            reason: 'final_origin_not_allowed'
          })
        }

        if (!response.ok) {
          try {
            await response.body?.cancel()
          } catch {
            // ignorado
          }
          throw downloadFailed('La CDN rechazó la descarga de la imagen.', {
            status: response.status
          })
        }

        const declaredMime = contentType(response.headers.get('content-type'))
        if (declaredMime === 'image/svg+xml') {
          try {
            await response.body?.cancel()
          } catch {
            // ignorado
          }
          throw invalid('La CDN devolvió un SVG; no se acepta SVG remoto.', {
            reason: 'svg_not_allowed'
          })
        }
        if (declaredMime && !ALLOWED_MIME.has(declaredMime)) {
          try {
            await response.body?.cancel()
          } catch {
            // ignorado
          }
          throw invalid('La CDN declara un tipo de contenido no permitido.', {
            declaredMime
          })
        }

        const bytes = await (async (): Promise<Uint8Array> => {
          try {
            return await readLimited(response, maxBytes)
          } catch (error) {
            if (error instanceof AppError) throw error
            if (options.signal?.aborted) throw abortFailure('aborted')
            throw abortFailure(timedOut ? 'timeout' : 'network')
          }
        })()
        return {
          bytes,
          declaredMime,
          sourceUrl: url,
          finalUrl: currentUrl,
          fromDataUrl: false
        }
      }
      throw downloadFailed('La imagen supera el número máximo de redirecciones.', { maxRedirects })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', externalAbort)
    }
  }
}
