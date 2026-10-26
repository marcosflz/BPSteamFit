import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'

export const MEDIA_SCHEME = 'bps-media'

export interface MediaResolution {
  filePath: string
}

export type MediaResolver = (url: URL) => Promise<MediaResolution | null>

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true
      }
    }
  ])
}

/**
 * Sirve imágenes locales solo a través de un resolvedor que valida el ID
 * contra la base de datos y la ruta contra la caché de la app. El renderer nunca
 * recibe rutas de archivo ni acceso al sistema.
 */
export function registerMediaProtocol(resolve: MediaResolver): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const resolution = await resolve(url)
      if (!resolution) {
        return new Response('No encontrado', { status: 404 })
      }
      return net.fetch(pathToFileURL(resolution.filePath).toString())
    } catch {
      return new Response('No encontrado', { status: 404 })
    }
  })
}

export function mediaUrl(assetId: string, variant = 'preview'): string {
  const encodedId = encodeURIComponent(assetId)
  return `${MEDIA_SCHEME}://asset/${encodedId}?variant=${encodeURIComponent(variant)}`
}
