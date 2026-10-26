import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { ArtworkIngestor, MemoryArtworkStorage } from '@core/artwork/ingest'
import type { FetchLike } from '@core/metadata/types'
import type { ArtworkCandidate } from '@core/metadata/types'
import type { ArtworkKind } from '@shared/domain'
import { fixture, dataUrl, startLocalServer, type LocalTestServer } from './helpers'

let portrait: Buffer
let hero: Buffer
let logo: Buffer
let icon: Buffer
let screenshot: Buffer

beforeAll(async () => {
  ;[portrait, hero, logo, icon, screenshot] = await Promise.all([
    fixture('example-quest-portrait.png'),
    fixture('example-quest-hero.png'),
    fixture('example-quest-logo.png'),
    fixture('example-quest-icon.png'),
    fixture('example-quest-screenshot-1.png')
  ])
})

function candidateFor(
  kind: ArtworkKind,
  bytes: Uint8Array,
  options: Partial<ArtworkCandidate> = {}
): ArtworkCandidate {
  return {
    provider: 'mock',
    providerAssetId: `asset-${kind}`,
    providerGameId: 'eq-2026',
    kind,
    url: dataUrl(bytes),
    width: 600,
    height: 900,
    mime: 'image/png',
    isMock: true,
    ...options
  }
}

describe('ingesta de artwork', () => {
  it('valida la imagen, conserva el original y genera portrait 600x900', async () => {
    const storage = new MemoryArtworkStorage()
    const ingestor = new ArtworkIngestor({ storage })
    const result = await ingestor.ingest(candidateFor('portrait', portrait))

    expect(result.original.format).toBe('png')
    expect(result.original.width).toBe(600)
    expect(result.original.height).toBe(900)
    expect(result.original.byteLength).toBe(portrait.byteLength)
    expect(Buffer.from(result.original.bytes).equals(portrait)).toBe(true)
    expect(result.variant.width).toBe(600)
    expect(result.variant.height).toBe(900)
    expect(result.variant.mime).toBe('image/png')
    expect(result.id).toMatch(/^[a-f0-9]{64}$/)
    expect(storage.size).toBe(2)
    expect(storage.has(`${result.id}/original.png`)).toBe(true)
    expect(storage.has(`${result.id}/portrait.png`)).toBe(true)
  })

  it('genera hero 1920x620 e icon 256x256', async () => {
    const ingestor = new ArtworkIngestor()
    const heroResult = await ingestor.ingest(candidateFor('hero', hero))
    expect([heroResult.variant.width, heroResult.variant.height]).toEqual([1920, 620])

    const iconResult = await ingestor.ingest(candidateFor('icon', icon))
    expect([iconResult.variant.width, iconResult.variant.height]).toEqual([256, 256])
  })

  it('mantiene el logo sin deformar, dentro de 1000x400 y con transparencia', async () => {
    const ingestor = new ArtworkIngestor()
    const result = await ingestor.ingest(candidateFor('logo', logo))
    expect(result.variant.width).toBeLessThanOrEqual(1000)
    expect(result.variant.height).toBeLessThanOrEqual(400)
    expect(result.variant.width).toBe(1000)
    expect(result.variant.height).toBe(400)
    const metadata = await sharp(result.variant.bytes).metadata()
    expect(metadata.hasAlpha).toBe(true)
    expect((metadata.width ?? 0) / (metadata.height ?? 1)).toBeCloseTo(1000 / 400, 3)
  })

  it('limita screenshots a 1920x1080 sin recortar el aspecto', async () => {
    const ingestor = new ArtworkIngestor()
    const small = await ingestor.ingest(candidateFor('screenshot', screenshot))
    expect([small.variant.width, small.variant.height]).toEqual([1280, 720])

    const large = await sharp({
      create: { width: 2400, height: 1350, channels: 3, background: '#123456' }
    })
      .png()
      .toBuffer()
    const result = await ingestor.ingest(candidateFor('screenshot', large))
    expect([result.variant.width, result.variant.height]).toEqual([1920, 1080])
  })

  it('hace center-crop real al generar un portrait', async () => {
    const square = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
          <rect width="600" height="600" fill="#0000ff"/>
          <circle cx="300" cy="300" r="220" fill="#ff0000"/>
        </svg>`
      )
    )
      .png()
      .toBuffer()
    const ingestor = new ArtworkIngestor()
    const result = await ingestor.ingest(candidateFor('portrait', square))
    expect([result.variant.width, result.variant.height]).toEqual([600, 900])
    const center = await sharp(result.variant.bytes)
      .extract({ left: 300, top: 450, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer()
    const corner = await sharp(result.variant.bytes)
      .extract({ left: 4, top: 4, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer()
    expect(center[0]).toBeGreaterThan(200)
    expect(center[2]).toBeLessThan(80)
    expect(corner[2]).toBeGreaterThan(200)
  })

  it('rechaza contenido que no es una imagen', async () => {
    const ingestor = new ArtworkIngestor()
    await expect(
      ingestor.ingest(candidateFor('portrait', Buffer.from('no soy una imagen')))
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })

  it('detecta un MIME falso aunque la cabecera diga image/png', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('esto es texto, no una imagen', {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    const ingestor = new ArtworkIngestor({ fetchImpl })
    await expect(
      ingestor.ingest({
        provider: 'steamgriddb',
        providerAssetId: '1',
        providerGameId: '12',
        kind: 'portrait',
        url: 'https://cdn2.steamgriddb.com/grid/fake.png',
        mime: 'image/png'
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })

  it('rechaza SVG remoto por MIME y por contenido real', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="red"/></svg>'
    )
    const byMime: FetchLike = async () =>
      new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
    await expect(
      new ArtworkIngestor({ fetchImpl: byMime }).ingest({
        provider: 'steamgriddb',
        providerAssetId: '1',
        providerGameId: '12',
        kind: 'portrait',
        url: 'https://cdn2.steamgriddb.com/grid/svg.png',
        mime: 'image/svg+xml'
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })

    const byContent: FetchLike = async () =>
      new Response(svg, { status: 200, headers: { 'content-type': 'image/png' } })
    await expect(
      new ArtworkIngestor({ fetchImpl: byContent }).ingest({
        provider: 'steamgriddb',
        providerAssetId: '2',
        providerGameId: '12',
        kind: 'portrait',
        url: 'https://cdn2.steamgriddb.com/grid/svg2.png',
        mime: 'image/png'
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })

    await expect(
      new ArtworkIngestor().ingest({
        provider: 'mock',
        providerAssetId: '3',
        providerGameId: 'eq',
        kind: 'portrait',
        url: dataUrl(svg, 'image/svg+xml')
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })

  it('rechaza tipos declarados que no son imágenes raster', async () => {
    const pngBody = new Uint8Array(portrait.byteLength)
    pngBody.set(portrait)
    const fetchImpl: FetchLike = async () =>
      new Response(pngBody.buffer, { status: 200, headers: { 'content-type': 'text/html' } })
    await expect(
      new ArtworkIngestor({ fetchImpl }).ingest({
        provider: 'steamgriddb',
        providerAssetId: '1',
        providerGameId: '12',
        kind: 'portrait',
        url: 'https://cdn2.steamgriddb.com/grid/a.png'
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })

  it('aplica el límite de bytes y de píxeles', async () => {
    const ingestor = new ArtworkIngestor({ maxBytes: 500 })
    await expect(
      ingestor.ingest(candidateFor('portrait', portrait))
    ).rejects.toMatchObject({ code: 'ARTWORK_TOO_LARGE' })

    const bigHeader: FetchLike = async () =>
      new Response(new Uint8Array(2_000), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '2000' }
      })
    await expect(
      new ArtworkIngestor({ fetchImpl: bigHeader, maxBytes: 100 }).ingest({
        provider: 'steamgriddb',
        providerAssetId: 'big',
        providerGameId: '12',
        kind: 'portrait',
        url: 'https://cdn2.steamgriddb.com/grid/big.png'
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_TOO_LARGE' })

    const big = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: '#888888' }
    })
      .png()
      .toBuffer()
    await expect(
      new ArtworkIngestor({ maxPixels: 100_000 }).ingest(candidateFor('portrait', big))
    ).rejects.toMatchObject({ code: 'ARTWORK_TOO_LARGE' })
  })

  it('rechaza orígenes no permitidos y redirecciones fuera de la lista', async () => {
    const valid = candidateFor('portrait', portrait, {
      url: 'http://127.0.0.1:1/portrait.png'
    })
    await expect(new ArtworkIngestor().ingest(valid)).rejects.toMatchObject({
      code: 'ARTWORK_INVALID'
    })

    await expect(
      new ArtworkIngestor().ingest({ ...valid, url: 'https://evil.example/portrait.png' })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })

    await expect(
      new ArtworkIngestor().ingest({ ...valid, url: 'file:///C:/portrait.png' })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })

    const redirecting: FetchLike = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/portrait.png' }
      })
    let fetchCalls = 0
    const fetchSpy = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls += 1
      return redirecting(input, init)
    }
    await expect(
      new ArtworkIngestor({ fetchImpl: fetchSpy }).ingest({
        provider: 'steamgriddb',
        providerAssetId: '1',
        providerGameId: '12',
        kind: 'portrait',
        url: 'https://cdn2.steamgriddb.com/grid/a.png'
      })
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
    expect(fetchCalls).toBe(1)
  })

  it('descarga desde un servidor local permitido y lo cierra al terminar', async () => {
    const server: LocalTestServer = await startLocalServer((request, response) => {
      if (request.url !== '/hero.png') {
        response.statusCode = 404
        response.end()
        return
      }
      response.setHeader('content-type', 'image/png')
      response.end(hero)
    })
    try {
      const ingestor = new ArtworkIngestor({
        allowedHosts: ['127.0.0.1'],
        allowInsecureLocalhost: true
      })
      const result = await ingestor.ingest({
        provider: 'steamgriddb',
        providerAssetId: 'hero-local',
        providerGameId: '12',
        kind: 'hero',
        url: `${server.url}/hero.png`,
        mime: 'image/png'
      })
      expect([result.variant.width, result.variant.height]).toEqual([1920, 620])
      expect(Buffer.from(result.original.bytes).equals(hero)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('envuelve fallos de almacenamiento en IO_ERROR', async () => {
    const ingestor = new ArtworkIngestor({
      storage: {
        put: async () => {
          throw new Error('disco lleno')
        }
      }
    })
    await expect(ingestor.ingest(candidateFor('portrait', portrait))).rejects.toMatchObject({
      code: 'IO_ERROR'
    })
  })
})
