import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeError } from '@shared/errors'
import { SteamGridDbProvider } from '@core/metadata/steamgriddb-provider'
import type { FetchLike } from '@core/metadata/types'
import { startLocalServer, type LocalTestServer } from './helpers'

const KEY = 'sgdb-test-key-not-real'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function provider(
  fetchImpl: FetchLike,
  overrides: ConstructorParameters<typeof SteamGridDbProvider>[0] = {}
): SteamGridDbProvider {
  return new SteamGridDbProvider({
    apiKey: KEY,
    fetchImpl,
    maxRetries: 0,
    timeoutMs: 1_000,
    ...overrides
  })
}

const searchEnvelope = {
  success: true,
  data: [
    {
      id: 12,
      name: 'Example Quest',
      verified: true,
      release_date: 1767225600
    }
  ]
}

describe('proveedor SteamGridDB v2', () => {
  it('no hace peticiones sin clave', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const sgdb = new SteamGridDbProvider({ fetchImpl })
    expect(sgdb.isConfigured()).toBe(false)
    expect(sgdb.info.requiresKey).toBe(true)
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_AUTH_REQUIRED'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('usa Bearer en la cabecera y nunca pone la clave en la URL', async () => {
    let captured: { url: string; init?: RequestInit } | undefined
    const fetchImpl: FetchLike = async (input, init) => {
      captured = { url: String(input), init }
      return json(searchEnvelope)
    }
    const sgdb = provider(fetchImpl)
    const candidates = await sgdb.searchCandidates('Example Quest / 2', {})

    expect(captured).toBeDefined()
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(captured?.url).not.toContain(KEY)
    expect(captured?.url).toContain('Example%20Quest%20%2F%202')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      key: 'steamgriddb:12',
      provider: 'steamgriddb',
      providerId: '12',
      title: 'Example Quest',
      releaseYear: 2026,
      verified: true,
      isMock: false
    })
  })

  it('obtiene el detalle sin inventar descripciones ni compañías', async () => {
    const fetchImpl: FetchLike = async () =>
      json({
        success: true,
        data: {
          id: 12,
          name: 'Example Quest',
          release_date: 1767225600,
          description: 'Esto no lo devuelve la API real y no debe usarse.'
        }
      })
    const sgdb = provider(fetchImpl)
    const metadata = await sgdb.getGame('12')
    expect(metadata).toMatchObject({
      title: 'Example Quest',
      provider: 'steamgriddb',
      providerId: '12',
      releaseYear: 2026,
      releaseDate: '2026-01-01',
      isMock: false
    })
    expect(metadata.description).toBeUndefined()
    expect(metadata.shortDescription).toBeUndefined()
    expect(metadata.developers).toBeUndefined()
    expect(metadata.publishers).toBeUndefined()
    expect(metadata.genres).toBeUndefined()
    expect(metadata.gameModes).toBeUndefined()
    expect(metadata.language).toBeUndefined()
  })

  it('valida la respuesta con Zod y produce un error tipado', async () => {
    const sgdb = provider(async () => json({ success: true, data: [{ id: 'no-numérico' }] }))
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_INVALID_RESPONSE'
    })
  })

  it('filtra artwork por tipo, aspecto, MIME, host y etiquetas seguras', async () => {
    let requestedUrl = ''
    const fetchImpl: FetchLike = async (input) => {
      requestedUrl = String(input)
      return json({
        success: true,
        data: [
          {
            id: 1,
            url: 'https://cdn2.steamgriddb.com/grid/a.png',
            thumb: 'https://cdn.steamgriddb.com/thumb/a.jpg',
            width: 600,
            height: 900,
            style: 'alternate',
            mime: 'image/png',
            tags: [],
            author: { name: 'Artista Demo' }
          },
          {
            id: 2,
            url: 'https://evil.example/grid.png',
            width: 600,
            height: 900,
            mime: 'image/png'
          },
          {
            id: 3,
            url: 'https://cdn2.steamgriddb.com/grid/square.png',
            width: 512,
            height: 512,
            mime: 'image/png'
          },
          {
            id: 4,
            url: 'https://cdn2.steamgriddb.com/grid/nsfw.png',
            width: 600,
            height: 900,
            mime: 'image/png',
            tags: ['nsfw']
          },
          {
            id: 5,
            url: 'https://cdn2.steamgriddb.com/grid/icon.ico',
            width: 256,
            height: 256,
            mime: 'image/vnd.microsoft.icon'
          }
        ]
      })
    }
    const sgdb = provider(fetchImpl)
    const candidates = await sgdb.listArtwork('12', 'portrait')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      providerAssetId: '1',
      kind: 'portrait',
      origin: 'provider',
      width: 600,
      height: 900,
      style: 'alternate',
      author: 'Artista Demo'
    })
    expect(candidates[0]?.attribution).toContain('Artista Demo')
    expect(candidates[0]?.thumbUrl).toBe('https://cdn.steamgriddb.com/thumb/a.jpg')

    const params = new URL(requestedUrl).searchParams
    expect(params.get('nsfw')).toBe('false')
    expect(params.get('humor')).toBe('false')
    expect(params.get('epilepsy')).toBe('false')
    expect(params.get('types')).toBe('static')
    expect(params.get('limit')).toBe('50')
    expect(params.get('dimensions')).toContain('600x900')
  })

  it('no inventa capturas: screenshot devuelve lista vacía sin red', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const sgdb = provider(fetchImpl)
    await expect(sgdb.listArtwork('12', 'screenshot')).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reintenta errores transitorios con backoff exponencial', async () => {
    let calls = 0
    const sleeps: number[] = []
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return calls === 1 ? json({}, 503) : json(searchEnvelope)
    }
    const sgdb = provider(fetchImpl, {
      maxRetries: 2,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      }
    })
    const candidates = await sgdb.searchCandidates('Example Quest', {})
    expect(candidates).toHaveLength(1)
    expect(calls).toBe(2)
    expect(sleeps).toEqual([300])
  })

  it('respeta Retry-After en 429', async () => {
    let calls = 0
    const sleeps: number[] = []
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return calls === 1
        ? json({}, 429, { 'retry-after': '1' })
        : json(searchEnvelope)
    }
    const sgdb = provider(fetchImpl, {
      maxRetries: 1,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      }
    })
    await sgdb.searchCandidates('Example Quest', {})
    expect(sleeps).toEqual([1000])
  })

  it('no reintenta si Retry-After supera el máximo permitido', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({}, 429, { 'retry-after': '120' }))
    const sgdb = provider(fetchImpl, { maxRetries: 2, maxRetryAfterMs: 30_000 })
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_RATE_LIMITED'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('no reintenta errores de autenticación', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ success: false, errors: ['invalid'] }, 401))
    const sgdb = provider(fetchImpl, { maxRetries: 2 })
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_AUTH_REQUIRED'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reintenta fallos de red y termina con error tipado', async () => {
    let calls = 0
    const sleeps: number[] = []
    const fetchImpl: FetchLike = async () => {
      calls += 1
      throw new TypeError('network down')
    }
    const sgdb = provider(fetchImpl, {
      maxRetries: 2,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      }
    })
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_PROVIDER_FAILED'
    })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([300, 600])
  })

  it('aplica timeout con AbortSignal', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    const sgdb = provider(fetchImpl, { timeoutMs: 20, maxRetries: 0 })
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_PROVIDER_FAILED',
      details: { reason: 'timeout' }
    })
  })

  it('cancela con la señal externa sin hacer la petición', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const sgdb = provider(fetchImpl)
    const controller = new AbortController()
    controller.abort()
    await expect(sgdb.searchCandidates('Example Quest', {}, controller.signal)).rejects.toMatchObject({
      code: 'METADATA_PROVIDER_FAILED',
      details: { reason: 'aborted' }
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('limita el tamaño de la respuesta', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('x'.repeat(2000), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '2000' }
      })
    const sgdb = provider(fetchImpl, { maxResponseBytes: 100 })
    await expect(sgdb.searchCandidates('Example Quest', {})).rejects.toMatchObject({
      code: 'METADATA_INVALID_RESPONSE'
    })
  })

  it('nunca incluye la clave en errores serializados', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`fallo interno con ${KEY}`)
    }
    const sgdb = provider(fetchImpl)
    try {
      await sgdb.searchCandidates('Example Quest', {})
      throw new Error('Debió fallar')
    } catch (error) {
      const serialized = JSON.stringify(serializeError(error))
      expect(serialized).not.toContain(KEY)
      expect(serialized).not.toContain('Bearer')
    }
  })

  describe('servidor HTTP local', () => {
    let server: LocalTestServer
    let seenAuthorization: string | undefined
    let seenUrl: string | undefined

    beforeAll(async () => {
      server = await startLocalServer((request, response) => {
        seenAuthorization = request.headers.authorization
        seenUrl = request.url
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(searchEnvelope))
      })
    })

    afterAll(async () => {
      await server.close()
    })

    it('funciona contra HTTP loopback solo con la opción de test', async () => {
      const sgdb = new SteamGridDbProvider({
        apiKey: KEY,
        baseUrl: `${server.url}/api/v2`,
        allowInsecureLocalhost: true,
        timeoutMs: 1_000,
        maxRetries: 0
      })
      const candidates = await sgdb.searchCandidates('Example Quest', {})
      expect(candidates[0]?.providerId).toBe('12')
      expect(seenAuthorization).toBe(`Bearer ${KEY}`)
      expect(seenUrl).not.toContain(KEY)
    })

    it('rechaza HTTP que no sea loopback', () => {
      expect(
        () =>
          new SteamGridDbProvider({
            apiKey: KEY,
            baseUrl: 'http://example.com/api/v2'
          })
      ).toThrow(/HTTPS/)
    })

    it('solo acepta el host oficial cuando usa HTTPS', () => {
      expect(
        () =>
          new SteamGridDbProvider({
            apiKey: KEY,
            baseUrl: 'https://evil.example/api/v2'
          })
      ).toThrow(/oficial|www\.steamgriddb\.com/i)
    })
  })
})
