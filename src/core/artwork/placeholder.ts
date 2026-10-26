import sharp from 'sharp'
import type { ArtworkKind } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { PlaceholderArtwork, PlaceholderOptions } from './types'

const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#0f2027', '#203a43', '#2c5364'],
  ['#3a1c71', '#d76d77', '#ffaf7b'],
  ['#1b4332', '#2d6a4f', '#95d5b2'],
  ['#402a23', '#a55233', '#f3bc77'],
  ['#231942', '#5e548e', '#e0b1cb']
]

const SIZE: Readonly<Record<ArtworkKind, { width: number; height: number }>> = {
  portrait: { width: 600, height: 900 },
  hero: { width: 1920, height: 620 },
  logo: { width: 1000, height: 400 },
  icon: { width: 256, height: 256 },
  screenshot: { width: 1920, height: 1080 }
}

function hashText(value: string): number {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function deriveInitials(title: string): string {
  const letters = title
    .split(/\s+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .filter(Boolean)
  if (letters.length === 0) return '?'
  return `${letters[0] ?? ''}${letters.length > 1 ? letters[letters.length - 1] ?? '' : ''}`.toLocaleUpperCase('es')
}

function wrapTitle(title: string, maxChars: number, maxLines: number): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length > maxChars && current.length > 0) {
      lines.push(current)
      if (lines.length >= maxLines) return lines
      current = word
    } else {
      current = candidate
    }
  }
  if (current.length > 0 && lines.length < maxLines) lines.push(current)
  return lines.length > 0 ? lines : ['Sin título']
}

function titleSvg(
  lines: string[],
  options: { x: number; y: number; size: number; lineHeight: number; fill: string; anchor?: 'start' | 'middle' }
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${options.x}" y="${options.y + index * options.lineHeight}" text-anchor="${options.anchor ?? 'start'}" font-family="Segoe UI, Arial, sans-serif" font-size="${options.size}" font-weight="700" fill="${options.fill}">${escapeXml(line)}</text>`
    )
    .join('')
}

function placeholderSvg(options: PlaceholderOptions, initials: string): {
  svg: string
  width: number
  height: number
} {
  const target = SIZE[options.kind]
  const { width, height } = target
  const palette = PALETTES[hashText(options.title || initials) % PALETTES.length] ?? PALETTES[0]
  if (!palette) throw new Error('Paleta de placeholder no disponible.')
  const [dark, mid, accent] = palette

  if (options.kind === 'logo') {
    const lines = wrapTitle(options.title, 22, 2)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="28" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="10 8" opacity="0.7"/>
      <text x="50%" y="43%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="120" font-weight="700" fill="#ffffff" opacity="0.92">${escapeXml(initials)}</text>
      ${titleSvg(lines, { x: 500, y: 300, size: 38, lineHeight: 44, fill: '#ffffff', anchor: 'middle' })}
      <text x="500" y="368" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="18" letter-spacing="5" fill="${accent}">SIN ARTWORK</text>
    </svg>`
    return { svg, width, height }
  }

  const compact = width === 256 || (height === 620 && width === 1920)
  const maxChars = options.kind === 'portrait' ? 16 : options.kind === 'icon' ? 8 : 30
  const lines = wrapTitle(options.title, maxChars, compact ? 2 : 3)
  const titleSize = options.kind === 'portrait' ? 54 : options.kind === 'icon' ? 40 : 86
  const titleY = options.kind === 'portrait' ? 690 : options.kind === 'hero' ? 470 : options.kind === 'icon' ? 200 : 800

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <circle cx="${Math.round(width * 0.82)}" cy="${Math.round(height * 0.2)}" r="${Math.round(Math.min(width, height) * 0.2)}" fill="url(#fade)"/>
    <path d="M0 ${Math.round(height * 0.72)} L${Math.round(width * 0.22)} ${Math.round(height * 0.58)} L${Math.round(width * 0.44)} ${Math.round(height * 0.71)} L${Math.round(width * 0.66)} ${Math.round(height * 0.55)} L${width} ${Math.round(height * 0.7)} L${width} ${height} L0 ${height} Z" fill="${dark}" opacity="0.6"/>
    <g opacity="0.18">
      <rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.08)}" width="${Math.round(width * 0.84)}" height="${Math.round(height * 0.84)}" rx="24" fill="none" stroke="${accent}" stroke-width="2"/>
    </g>
    <text x="${Math.round(width / 2)}" y="${Math.round(height * 0.36)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.22)}" font-weight="800" fill="#ffffff" opacity="0.92">${escapeXml(initials)}</text>
    ${titleSvg(lines, { x: Math.round(width / 2), y: titleY, size: titleSize, lineHeight: Math.round(titleSize * 1.12), fill: '#ffffff', anchor: 'middle' })}
    <text x="${Math.round(width / 2)}" y="${height - Math.round(Math.min(width, height) * 0.06)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.035)}" letter-spacing="6" fill="${accent}">SIN ARTWORK · BPSteamFit</text>
  </svg>`
  return { svg, width, height }
}

/**
 * Placeholder local propio, sin IA ni arte de terceros. Usa iniciales y un
 * estilo determinista derivado del título, por lo que el mismo juego produce
 * siempre la misma imagen.
 */
export async function createPlaceholderArtwork(options: PlaceholderOptions): Promise<PlaceholderArtwork> {
  const title = options.title.trim()
  if (title.length === 0) {
    throw new AppError('ARTWORK_INVALID', 'El placeholder necesita un título.')
  }
  const initials = (options.initials?.trim() || deriveInitials(title)).slice(0, 3)
  const { svg, width, height } = placeholderSvg({ ...options, title }, initials)
  try {
    const { data, info } = await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true })
    return {
      kind: options.kind,
      bytes: new Uint8Array(data),
      mime: 'image/png',
      width: info.width,
      height: info.height,
      initials
    }
  } catch (error) {
    throw new AppError('ARTWORK_INVALID', 'No se pudo generar el placeholder de artwork.', {
      cause: error instanceof Error ? error.message : String(error)
    })
  }
}
