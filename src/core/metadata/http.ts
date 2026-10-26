import { AppError } from '@shared/errors'
import type { FetchLike } from './types'

const DEFAULT_SLEEP = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export interface JsonRequestOptions {
  url: string
  headers: Readonly<Record<string, string>>
  fetchImpl: FetchLike
  signal?: AbortSignal
  timeoutMs: number
  maxRetries: number
  maxResponseBytes: number
  maxRetryAfterMs: number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface JsonResponse {
  status: number
  value: unknown
  /** Cabeceras seleccionadas; nunca se expone la petición ni la clave. */
  headers: Headers
}

export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number.parseInt(trimmed, 10) * 1000)
  }
  const date = Date.parse(trimmed)
  if (!Number.isFinite(date)) return null
  return Math.max(0, date - nowMs)
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

function abortError(reason: 'aborted' | 'timeout'): AppError {
  return new AppError(
    'METADATA_PROVIDER_FAILED',
    reason === 'timeout'
      ? 'El proveedor de metadatos tardó demasiado en responder.'
      : 'La consulta al proveedor de metadatos se canceló.',
    { details: { reason } }
  )
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // El cuerpo ya está cerrado o el fetch de prueba no lo implementa.
  }
}

/** Lee el cuerpo con un límite estricto, incluso si no hay Content-Length. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    if (Number.parseInt(contentLength, 10) > maxBytes) {
      await cancelBody(response)
      throw new AppError('METADATA_INVALID_RESPONSE', 'La respuesta del proveedor supera el tamaño permitido.', {
        details: { reason: 'response_too_large', maxBytes }
      })
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new AppError('METADATA_INVALID_RESPONSE', 'La respuesta del proveedor supera el tamaño permitido.', {
        details: { reason: 'response_too_large', maxBytes }
      })
    }
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
        throw new AppError(
          'METADATA_INVALID_RESPONSE',
          'La respuesta del proveedor supera el tamaño permitido.',
          { details: { reason: 'response_too_large', maxBytes } }
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function sleepWithAbort(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>
): Promise<void> {
  if (signal?.aborted) throw abortError('aborted')
  const pending = sleep(milliseconds)
  if (!signal) {
    await pending
    return
  }
  let listener: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(abortError('aborted'))
    signal.addEventListener('abort', listener, { once: true })
  })
  try {
    await Promise.race([pending, aborted])
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}

/**
 * GET JSON con timeout, tamaño máximo, backoff limitado y respeto de
 * Retry-After. Solo reintenta errores de red, 408/425/429 y 5xx.
 */
export async function requestJsonWithRetry(options: JsonRequestOptions): Promise<JsonResponse> {
  const sleep = options.sleep ?? DEFAULT_SLEEP
  const attempts = Math.max(0, options.maxRetries) + 1
  let lastError: AppError | undefined

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError('aborted')

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    const externalAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', externalAbort, { once: true })

    try {
      const response = await options.fetchImpl(options.url, {
        method: 'GET',
        headers: options.headers,
        // La API no necesita redirecciones; rechazarlas evita enviar la
        // cabecera Authorization a otro origen.
        redirect: 'error',
        signal: controller.signal
      })

      if (response.status === 401 || response.status === 403) {
        await cancelBody(response)
        throw new AppError(
          'METADATA_AUTH_REQUIRED',
          'La clave de SteamGridDB no es válida o no tiene permisos.'
        )
      }

      if (isRetryableStatus(response.status)) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
        await cancelBody(response)
        if (response.status === 429 && retryAfter !== null && retryAfter > options.maxRetryAfterMs) {
          throw new AppError(
            'METADATA_RATE_LIMITED',
            'SteamGridDB pidió esperar más de lo permitido; no se reintenta automáticamente.',
            { details: { status: 429, retryAfterMs: retryAfter, retryable: false } }
          )
        }
        const wait =
          response.status === 429 && retryAfter !== null
            ? retryAfter
            : Math.min(30_000, 300 * 2 ** attempt)
        lastError = new AppError(
          response.status === 429 ? 'METADATA_RATE_LIMITED' : 'METADATA_PROVIDER_FAILED',
          response.status === 429
            ? 'SteamGridDB limitó temporalmente las peticiones.'
            : 'SteamGridDB devolvió un error temporal.',
          { details: { status: response.status } }
        )
        if (attempt + 1 >= attempts) throw lastError
        await sleepWithAbort(wait, options.signal, sleep)
        continue
      }

      if (!response.ok) {
        await cancelBody(response)
        throw new AppError(
          response.status === 404 ? 'METADATA_PROVIDER_FAILED' : 'METADATA_PROVIDER_FAILED',
          response.status === 404
            ? 'El recurso solicitado no existe en SteamGridDB.'
            : 'SteamGridDB rechazó la petición.',
          { details: { status: response.status } }
        )
      }

      const bytes = await readResponseBytes(response, options.maxResponseBytes)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new AppError('METADATA_INVALID_RESPONSE', 'La respuesta del proveedor no es UTF-8 válido.')
      }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new AppError('METADATA_INVALID_RESPONSE', 'La respuesta del proveedor no es JSON válido.')
      }
      return { status: response.status, value, headers: response.headers }
    } catch (error) {
      if (error instanceof AppError) {
        if (error.details?.retryable === false) throw error
        if (!isRetryableStatus(responseStatus(error))) throw error
        lastError = error
      } else {
        const reason: 'aborted' | 'timeout' = timedOut
          ? 'timeout'
          : options.signal?.aborted
            ? 'aborted'
            : 'timeout'
        if (reason === 'aborted' && options.signal?.aborted) throw abortError('aborted')
        lastError = new AppError(
          'METADATA_PROVIDER_FAILED',
          timedOut
            ? 'El proveedor de metadatos tardó demasiado en responder.'
            : 'No se pudo conectar con el proveedor de metadatos.',
          { details: { reason: timedOut ? 'timeout' : 'network' } }
        )
      }

      if (attempt + 1 >= attempts) throw lastError
      await sleepWithAbort(Math.min(30_000, 300 * 2 ** attempt), options.signal, sleep)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', externalAbort)
    }
  }

  throw lastError ?? new AppError('METADATA_PROVIDER_FAILED', 'El proveedor no respondió.')
}

function responseStatus(error: AppError): number {
  const status = error.details?.status
  return typeof status === 'number' ? status : 0
}
