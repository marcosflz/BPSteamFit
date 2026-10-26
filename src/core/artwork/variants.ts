import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { ArtworkKind } from '@shared/domain'
import { AppError } from '@shared/errors'
import { ARTWORK_DOWNLOAD_DEFAULTS, ARTWORK_TARGET_DIMENSIONS, type ArtworkVariant } from './types'

export type SupportedImageFormat = 'png' | 'jpeg' | 'webp'

type SharpPipeline = ReturnType<typeof sharp>
type SharpInputMetadata = Awaited<ReturnType<SharpPipeline['metadata']>>

export interface DetectedImage {
  format: SupportedImageFormat
  mime: string
  width: number
  height: number
  hasAlpha: boolean
}

const FORMAT_TO_MIME: Readonly<Record<SupportedImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

const SUPPORTED_FORMATS = new Set<string>(['png', 'jpeg', 'webp'])

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Valida que los bytes sean una imagen raster real soportada por sharp.
 * Rechaza SVG explícitamente y aplica el límite de píxeles antes de decodificar.
 */
export async function detectImage(
  bytes: Uint8Array,
  options: { maxPixels?: number } = {}
): Promise<DetectedImage> {
  const maxPixels = options.maxPixels ?? ARTWORK_DOWNLOAD_DEFAULTS.maxPixels
  let metadata: SharpInputMetadata
  try {
    metadata = await sharp(Buffer.from(bytes), {
      failOn: 'error',
      limitInputPixels: maxPixels
    }).metadata()
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/pixel limit|limitinputpixels/i.test(message)) {
      throw new AppError('ARTWORK_TOO_LARGE', 'La imagen supera el límite de píxeles permitido.', {
        details: { maxPixels }
      })
    }
    throw new AppError('ARTWORK_INVALID', 'El contenido descargado no es una imagen válida.', {
      cause: message
    })
  }

  const format = metadata.format
  if (format === 'svg') {
    throw new AppError('ARTWORK_INVALID', 'Los SVG no se aceptan como artwork.', {
      details: { reason: 'svg_not_allowed' }
    })
  }
  if (!format || !SUPPORTED_FORMATS.has(format) || !metadata.width || !metadata.height) {
    throw new AppError('ARTWORK_INVALID', 'El formato de imagen no está permitido.', {
      details: { format: format ?? 'desconocido' }
    })
  }
  if (metadata.width * metadata.height > maxPixels) {
    throw new AppError('ARTWORK_TOO_LARGE', 'La imagen supera el límite de píxeles permitido.', {
      details: { maxPixels, width: metadata.width, height: metadata.height }
    })
  }

  return {
    format: format as SupportedImageFormat,
    mime: FORMAT_TO_MIME[format as SupportedImageFormat],
    width: metadata.width,
    height: metadata.height,
    hasAlpha: metadata.hasAlpha === true
  }
}

function pngOutput(
  data: Buffer,
  info: { width: number; height: number }
): { bytes: Uint8Array; width: number; height: number } {
  return {
    bytes: new Uint8Array(data),
    width: info.width,
    height: info.height
  }
}

/**
 * Genera la variante del tipo solicitado. No convierte entre tipos: un
 * candidato `portrait` nunca se usa para producir un `hero`.
 */
export async function renderArtworkVariant(
  input: Uint8Array,
  kind: ArtworkKind,
  options: { maxPixels?: number } = {}
): Promise<ArtworkVariant> {
  const maxPixels = options.maxPixels ?? ARTWORK_DOWNLOAD_DEFAULTS.maxPixels
  const pipeline = (): SharpPipeline =>
    sharp(Buffer.from(input), { failOn: 'error', limitInputPixels: maxPixels }).rotate()

  let output: { bytes: Uint8Array; width: number; height: number }
  try {
    switch (kind) {
      case 'portrait': {
        const target = ARTWORK_TARGET_DIMENSIONS.portrait
        const result = await pipeline()
          .resize(target.width, target.height, { fit: 'cover', position: 'centre' })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
        output = pngOutput(result.data, result.info)
        break
      }
      case 'hero': {
        const target = ARTWORK_TARGET_DIMENSIONS.hero
        const result = await pipeline()
          .resize(target.width, target.height, { fit: 'cover', position: 'centre' })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
        output = pngOutput(result.data, result.info)
        break
      }
      case 'icon': {
        const target = ARTWORK_TARGET_DIMENSIONS.icon
        const result = await pipeline()
          .resize(target.width, target.height, { fit: 'cover', position: 'centre' })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
        output = pngOutput(result.data, result.info)
        break
      }
      case 'logo': {
        const result = await pipeline()
          .resize({
            width: 1000,
            height: 400,
            fit: 'inside',
            withoutEnlargement: true
          })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
        output = pngOutput(result.data, result.info)
        break
      }
      case 'screenshot': {
        const target = ARTWORK_TARGET_DIMENSIONS.screenshot
        const result = await pipeline()
          .resize({
            width: target.width,
            height: target.height,
            fit: 'inside',
            withoutEnlargement: true
          })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
        output = pngOutput(result.data, result.info)
        break
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('ARTWORK_INVALID', 'No se pudo generar la variante de artwork.', {
      cause: error instanceof Error ? error.message : String(error)
    })
  }

  return {
    kind,
    bytes: output.bytes,
    byteLength: output.bytes.byteLength,
    mime: 'image/png',
    width: output.width,
    height: output.height,
    sha256: sha256Bytes(output.bytes)
  }
}

export const ARTWORK_TARGET_ASPECT: Readonly<Record<ArtworkKind, number | null>> = {
  portrait: 2 / 3,
  hero: 1920 / 620,
  logo: null,
  icon: 1,
  screenshot: 16 / 9
}

const ASPECT_TOLERANCE: Readonly<Record<ArtworkKind, number>> = {
  portrait: 0.25,
  hero: 0.28,
  logo: 1,
  icon: 0.12,
  screenshot: 0.3
}

/** Comprueba tipo y relación de aspecto; un retrato nunca pasa como hero. */
export function isAspectCompatible(
  kind: ArtworkKind,
  width: number | undefined,
  height: number | undefined,
  tolerance = ASPECT_TOLERANCE[kind]
): boolean {
  if (!width || !height || width <= 0 || height <= 0) return false
  const target = ARTWORK_TARGET_ASPECT[kind]
  if (target === null) return true
  const ratio = width / height
  return Math.abs(ratio - target) / target <= tolerance
}

export function aspectTolerance(kind: ArtworkKind): number {
  return ASPECT_TOLERANCE[kind]
}
