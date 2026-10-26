import { z } from 'zod'
import type { ArtworkKind, GameMetadata } from '@shared/domain'
import { AppError } from '@shared/errors'
import { requestJsonWithRetry } from './http'
import {
  STEAMGRIDDB_ATTRIBUTION,
  type ArtworkCandidate,
  type FetchLike,
  type ListArtworkOptions,
  type MetadataProvider,
  type MetadataProviderInfo,
  type ProviderCandidate,
  type SearchHints
} from './types'

const API_BASE_URL = 'https://www.steamgriddb.com/api/v2'
const ALLOWED_IMAGE_HOSTS = new Set(['cdn.steamgriddb.com', 'cdn2.steamgriddb.com'])

const gameSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(300),
    types: z.array(z.string()).optional(),
    verified: z.boolean().optional(),
    release_date: z.number().int().nonnegative().nullable().optional()
  })
  .passthrough()

const gamesEnvelopeSchema = z
  .object({
    success: z.boolean(),
    data: z.array(gameSchema).max(200),
    errors: z.array(z.string()).optional()
  })
  .passthrough()

const gameEnvelopeSchema = z
  .object({
    success: z.boolean(),
    data: z.union([gameSchema, z.array(gameSchema).min(1).max(1)]),
    errors: z.array(z.string()).optional()
  })
  .passthrough()

const imageSchema = z
  .object({
    id: z.number().int().positive(),
    url: z.string().min(1).max(2048),
    thumb: z.string().min(1).max(2048).optional(),
    score: z.number().optional(),
    style: z.union([z.string(), z.array(z.string())]).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    mime: z.string().max(100).optional(),
    language: z.string().max(50).optional(),
    type: z.string().max(50).optional(),
    tags: z.array(z.string()).optional(),
    author: z
      .object({
        name: z.string().max(200).optional(),
        steam64: z.string().max(30).optional(),
        avatar: z.string().max(2048).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough()

const imagesEnvelopeSchema = z
  .object({
    success: z.boolean(),
    data: z.array(imageSchema).max(200),
    errors: z.array(z.string()).optional()
  })
  .passthrough()

interface KindQuery {
  path: string
  params: Record<string, string>
}

function kindQuery(kind: ArtworkKind): KindQuery | null {
  switch (kind) {
    case 'portrait':
      return {
        path: 'grids',
        params: {
          dimensions: '600x900,342x482,660x930',
          types: 'static',
          mimes: 'image/png,image/jpeg,image/webp',
          styles: 'alternate,blurred,white_logo,material,no_logo'
        }
      }
    case 'hero':
      return {
        path: 'heroes',
        params: {
          dimensions: '1920x620,3840x1240,1600x650',
          types: 'static',
          mimes: 'image/png,image/jpeg,image/webp',
          styles: 'alternate,blurred,material'
        }
      }
    case 'logo':
      return {
        path: 'logos',
        params: {
          types: 'static',
          mimes: 'image/png,image/webp',
          styles: 'official,white,black,custom'
        }
      }
    case 'icon':
      return {
        path: 'icons',
        params: {
          types: 'static',
          mimes: 'image/png',
          styles: 'official,custom'
        }
      }
    case 'screenshot':
      // La API v2 no tiene endpoint de capturas. No se inventa ni se usa otro tipo.
      return null
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new AppError('METADATA_INVALID_RESPONSE', `La respuesta de SteamGridDB no es válida (${what}).`, {
      details: {
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code
        }))
      }
    })
  }
  return parsed.data
}

function isAllowedImageUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.port === '' || url.port === '443') &&
    ALLOWED_IMAGE_HOSTS.has(url.hostname.toLocaleLowerCase('en-US'))
  )
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase('en-US')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

function releaseDateInfo(value: number | undefined): { releaseYear?: number; releaseDate?: string } {
  if (value === undefined || value === 0) return {}
  const milliseconds = value > 10_000_000_000 ? value : value * 1000
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) return {}
  const year = date.getUTCFullYear()
  if (year < 1900 || year > 2100) return {}
  return {
    releaseYear: year,
    releaseDate: date.toISOString().slice(0, 10)
  }
}

function normalizedStyle(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value.join(' / ') : undefined
  return value?.trim() || undefined
}

function ratioAcceptable(kind: ArtworkKind, width?: number, height?: number): boolean {
  if (!width || !height) return true
  const ratio = width / height
  switch (kind) {
    case 'portrait':
      return ratio >= 0.45 && ratio <= 0.9
    case 'hero':
      return ratio >= 1.8 && ratio <= 4
    case 'icon':
      return ratio >= 0.9 && ratio <= 1.1
    case 'logo':
      return ratio <= 12
    case 'screenshot':
      return ratio >= 1.2 && ratio <= 2.4
  }
}

function mimeAcceptable(kind: ArtworkKind, mime: string | undefined): boolean {
  if (!mime) return true
  const normalized = mime.toLocaleLowerCase('en-US')
  if (kind === 'icon') return normalized === 'image/png'
  if (kind === 'logo') return normalized === 'image/png' || normalized === 'image/webp'
  return normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp'
}

function tagsAreSafe(tags: string[] | undefined): boolean {
  if (!tags) return true
  const normalized = tags.map((tag) => tag.toLocaleLowerCase('en-US'))
  return !normalized.some((tag) => tag === 'nsfw' || tag === 'humor' || tag === 'epilepsy')
}

export interface SteamGridDbOptions {
  apiKey?: string
  fetchImpl?: FetchLike
  /** Solo para pruebas locales; el valor por defecto es la API oficial HTTPS. */
  baseUrl?: string
  /** Permite HTTP únicamente contra loopback, para tests. */
  allowInsecureLocalhost?: boolean
  timeoutMs?: number
  maxRetries?: number
  maxResponseBytes?: number
  maxRetryAfterMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
}

/**
 * Proveedor real de SteamGridDB v2. Solo identidad y artwork: SGDB no
 * documenta descripciones, desarrolladores, editoriales, géneros ni capturas.
 * La clave se guarda en un campo privado de JS y solo viaja en la cabecera
 * Authorization; nunca se incluye en URLs, errores ni logs.
 */
export class SteamGridDbProvider implements MetadataProvider {
  readonly info: MetadataProviderInfo = {
    id: 'steamgriddb',
    name: 'SteamGridDB',
    requiresKey: true,
    capabilities: {
      identity: true,
      details: true,
      artworkKinds: ['portrait', 'hero', 'logo', 'icon'],
      descriptions: false,
      developers: false,
      publishers: false,
      releaseYear: false,
      screenshots: false
    },
    description:
      'Proveedor opcional: identidad por nombre y arte de la comunidad. No ofrece descripciones, compañías, géneros ni capturas.',
    attribution: STEAMGRIDDB_ATTRIBUTION
  }

  readonly #apiKey: string | null
  readonly #fetch: FetchLike
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #maxRetries: number
  readonly #maxResponseBytes: number
  readonly #maxRetryAfterMs: number
  readonly #sleep?: (milliseconds: number) => Promise<void>
  readonly #now: () => Date

  constructor(options: SteamGridDbOptions = {}) {
    const key = options.apiKey?.trim() ?? ''
    this.#apiKey = key.length > 0 ? key : null
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.#now = options.now ?? (() => new Date())
    this.#timeoutMs = options.timeoutMs ?? 8_000
    this.#maxRetries = options.maxRetries ?? 2
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_000_000
    this.#maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000
    this.#sleep = options.sleep

    const baseUrl = options.baseUrl ?? API_BASE_URL
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new AppError('VALIDATION_ERROR', 'La URL base de SteamGridDB no es válida.')
    }
    const localHttpAllowed =
      parsed.protocol === 'http:' && options.allowInsecureLocalhost === true && isLoopback(parsed.hostname)
    if (parsed.protocol !== 'https:' && !localHttpAllowed) {
      throw new AppError(
        'VALIDATION_ERROR',
        'SteamGridDB debe usar HTTPS. HTTP solo se permite contra loopback en pruebas.'
      )
    }
    if (parsed.username || parsed.password) {
      throw new AppError('VALIDATION_ERROR', 'La URL base de SteamGridDB no puede contener credenciales.')
    }
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLocaleLowerCase('en-US') !== 'www.steamgriddb.com'
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        'La URL base HTTPS debe pertenecer al host oficial www.steamgriddb.com.'
      )
    }
    this.#baseUrl = parsed.toString().replace(/\/+$/, '')
  }

  isConfigured(): boolean {
    return this.#apiKey !== null
  }

  async searchCandidates(
    query: string,
    _hints: SearchHints,
    signal?: AbortSignal
  ): Promise<ProviderCandidate[]> {
    this.ensureConfigured()
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const url = this.url(`/search/autocomplete/${encodeURIComponent(trimmed)}`)
    const response = await this.getJson(url, signal)
    const parsed = parseOrThrow(gamesEnvelopeSchema, response.value, 'búsqueda')
    if (!parsed.success) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'SteamGridDB no completó la búsqueda.')
    }
    return parsed.data.slice(0, 50).map((game) => {
      const release = releaseDateInfo(game.release_date ?? undefined)
      const candidate: ProviderCandidate = {
        key: `${this.info.id}:${game.id}`,
        provider: this.info.id,
        providerId: String(game.id),
        title: game.name,
        releaseYear: release.releaseYear,
        isMock: false
      }
      if (game.verified !== undefined) candidate.verified = game.verified
      return candidate
    })
  }

  async getGame(providerId: string, options: { signal?: AbortSignal } = {}): Promise<GameMetadata> {
    this.ensureConfigured()
    const id = this.numericId(providerId)
    const url = this.url(`/games/id/${id}`)
    const response = await this.getJson(url, options.signal)
    const parsed = parseOrThrow(gameEnvelopeSchema, response.value, 'detalle')
    if (!parsed.success) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'SteamGridDB no devolvió el juego solicitado.')
    }
    const game = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data
    if (!game) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'SteamGridDB no devolvió el juego solicitado.')
    }
    if (String(game.id) !== id) {
      throw new AppError('METADATA_INVALID_RESPONSE', 'SteamGridDB devolvió un juego distinto al solicitado.')
    }
    const release = releaseDateInfo(game.release_date ?? undefined)
    const metadata: GameMetadata = {
      title: game.name,
      provider: this.info.id,
      providerId: String(game.id),
      fetchedAt: this.#now().toISOString(),
      isMock: false
    }
    // No se rellenan descripciones, compañías, géneros ni modos: SGDB no los
    // expone en v2. Inventarlos violaría el contrato del proveedor.
    if (release.releaseYear !== undefined) metadata.releaseYear = release.releaseYear
    if (release.releaseDate !== undefined) metadata.releaseDate = release.releaseDate
    return metadata
  }

  async listArtwork(
    providerGameId: string,
    kind: ArtworkKind,
    options: ListArtworkOptions = {}
  ): Promise<ArtworkCandidate[]> {
    const query = kindQuery(kind)
    if (!query) return []
    this.ensureConfigured()
    const id = this.numericId(providerGameId)

    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 50)))
    const url = this.url(`/${query.path}/game/${id}`, {
      ...query.params,
      nsfw: 'false',
      humor: 'false',
      epilepsy: 'false',
      limit: String(limit),
      page: '0'
    })
    const response = await this.getJson(url, options.signal)
    const parsed = parseOrThrow(imagesEnvelopeSchema, response.value, `artwork ${kind}`)
    if (!parsed.success) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'SteamGridDB no devolvió el artwork solicitado.')
    }

    const candidates: ArtworkCandidate[] = []
    for (const image of parsed.data) {
      if (!isAllowedImageUrl(image.url)) continue
      if (!mimeAcceptable(kind, image.mime)) continue
      if (!ratioAcceptable(kind, image.width, image.height)) continue
      if (!tagsAreSafe(image.tags)) continue
      const thumbUrl = image.thumb && isAllowedImageUrl(image.thumb) ? image.thumb : undefined
      const author = image.author?.name?.trim() || undefined
      const candidate: ArtworkCandidate = {
        provider: this.info.id,
        providerAssetId: String(image.id),
        providerGameId: id,
        kind,
        origin: 'provider',
        url: image.url,
        width: image.width,
        height: image.height,
        mime: image.mime,
        style: normalizedStyle(image.style),
        language: image.language,
        author,
        attribution: author
          ? `Arte de la comunidad de SteamGridDB · ${author}`
          : 'Arte de la comunidad de SteamGridDB',
        tags: image.tags,
        isMock: false
      }
      if (thumbUrl) candidate.thumbUrl = thumbUrl
      candidates.push(candidate)
      if (candidates.length >= limit) break
    }
    return candidates
  }

  private ensureConfigured(): void {
    if (!this.#apiKey) {
      throw new AppError(
        'METADATA_AUTH_REQUIRED',
        'Falta la clave de SteamGridDB. La aplicación puede seguir usando el proveedor de demostración.'
      )
    }
  }

  private numericId(providerId: string): string {
    const trimmed = providerId.trim()
    if (!/^\d{1,15}$/.test(trimmed)) {
      throw new AppError('VALIDATION_ERROR', 'El identificador de SteamGridDB debe ser numérico.')
    }
    return trimmed
  }

  private url(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value)
    }
    return url.toString()
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<{ status: number; value: unknown }> {
    const key = this.#apiKey
    if (!key) this.ensureConfigured()
    const response = await requestJsonWithRetry({
      url,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'BPSteamFit/0.1 (metadata-provider)'
      },
      fetchImpl: this.#fetch,
      signal,
      timeoutMs: this.#timeoutMs,
      maxRetries: this.#maxRetries,
      maxResponseBytes: this.#maxResponseBytes,
      maxRetryAfterMs: this.#maxRetryAfterMs,
      sleep: this.#sleep
    })
    return { status: response.status, value: response.value }
  }
}
