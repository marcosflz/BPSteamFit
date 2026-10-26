import sharp from 'sharp'
import type { ArtworkKind, GameMetadata } from '@shared/domain'
import { AppError } from '@shared/errors'
import {
  MOCK_ATTRIBUTION,
  type ArtworkCandidate,
  type ListArtworkOptions,
  type MetadataLanguage,
  type MetadataProvider,
  type MetadataProviderInfo,
  type ProviderCandidate,
  type SearchHints
} from './types'
import { normalizeTitle } from './normalization'

interface MockLocalizedText {
  title: string
  shortDescription: string
  description: string
  genres: string[]
  gameModes: string[]
}

interface MockGameFixture {
  id: string
  releaseYear: number
  releaseDate: string
  edition?: string
  searchTerms: string[]
  es: MockLocalizedText
  en: MockLocalizedText
}

const FIXTURES: readonly MockGameFixture[] = [
  {
    id: 'eq-2026',
    releaseYear: 2026,
    releaseDate: '2026-03-12',
    searchTerms: ['example quest'],
    es: {
      title: 'Example Quest',
      shortDescription:
        'Aventura de puzles de demostración sobre un faro que guarda recuerdos ajenos.',
      description:
        'Example Quest es un juego ficticio creado para probar el catálogo de BPSteamFit. La protagonista recorre un faro abandonado, reordena recuerdos y decide qué historias merecen conservarse. No es un juego real ni procede de ningún editor existente.',
      genres: ['Aventura', 'Puzles'],
      gameModes: ['Un jugador']
    },
    en: {
      title: 'Example Quest',
      shortDescription:
        'A demo puzzle adventure about a lighthouse that stores other people’s memories.',
      description:
        'Example Quest is a fictional game made to exercise the BPSteamFit catalog. The protagonist explores an abandoned lighthouse, rearranges memories and decides which stories are worth keeping. It is not a real game and does not come from any existing publisher.',
      genres: ['Adventure', 'Puzzle'],
      gameModes: ['Single-player']
    }
  },
  {
    id: 'eq2-2028',
    releaseYear: 2028,
    releaseDate: '2028-09-18',
    searchTerms: ['example quest 2'],
    es: {
      title: 'Example Quest 2',
      shortDescription:
        'Segunda parte ficticia: el faro despierta y las mareas devuelven recuerdos incompletos.',
      description:
        'Example Quest 2 continúa la demo con una costa nueva, más puzles y una banda sonora original imaginaria. Es una secuela ficticia incluida para comprobar que la resolución de identidad no confunde números de secuela.',
      genres: ['Aventura', 'Puzles'],
      gameModes: ['Un jugador']
    },
    en: {
      title: 'Example Quest 2',
      shortDescription:
        'A fictional sequel: the lighthouse wakes and the tides return incomplete memories.',
      description:
        'Example Quest 2 continues the demo with a new coastline, more puzzles and an imaginary original soundtrack. It is a fictional sequel included to verify that identity resolution does not confuse sequel numbers.',
      genres: ['Adventure', 'Puzzle'],
      gameModes: ['Single-player']
    }
  },
  {
    id: 'eq-remake-2024',
    releaseYear: 2024,
    releaseDate: '2024-11-07',
    searchTerms: ['example quest remake'],
    es: {
      title: 'Example Quest Remake',
      shortDescription:
        'Reimaginación ficticia de Example Quest con otra dirección artística y los mismos puzles.',
      description:
        'Example Quest Remake es una versión ficticia de 2024 incluida para probar que un remake no se confunde con el juego original de 2026. Su año y su etiqueta de variante son deliberadamente distintos.',
      genres: ['Aventura', 'Puzles'],
      gameModes: ['Un jugador']
    },
    en: {
      title: 'Example Quest Remake',
      shortDescription:
        'A fictional reimagining of Example Quest with a different art direction and the same puzzles.',
      description:
        'Example Quest Remake is a fictional 2024 release included to verify that a remake is not confused with the original 2026 game. Its year and variant tag are deliberately different.',
      genres: ['Adventure', 'Puzzle'],
      gameModes: ['Single-player']
    }
  },
  {
    id: 'eq-deluxe-2026',
    releaseYear: 2026,
    releaseDate: '2026-03-12',
    edition: 'Deluxe Edition',
    searchTerms: ['example quest deluxe'],
    es: {
      title: 'Example Quest: Deluxe Edition',
      shortDescription:
        'Edición ficticia de demostración con galería conceptual y banda sonora imaginaria.',
      description:
        'Example Quest: Deluxe Edition es una edición ficticia del mismo año que el juego base. Sirve para comprobar que la resolución conserva la etiqueta de edición y no la descarta al normalizar el título.',
      genres: ['Aventura', 'Puzles'],
      gameModes: ['Un jugador']
    },
    en: {
      title: 'Example Quest: Deluxe Edition',
      shortDescription:
        'A fictional demo edition with a concept gallery and an imaginary soundtrack.',
      description:
        'Example Quest: Deluxe Edition is a fictional edition released in the same year as the base game. It verifies that resolution keeps the edition tag instead of discarding it during title normalization.',
      genres: ['Adventure', 'Puzzle'],
      gameModes: ['Single-player']
    }
  }
]

const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#102a43', '#2f6f8f', '#ffd166'],
  ['#2b2d42', '#8d99ae', '#ef233c'],
  ['#1b4332', '#40916c', '#b7e4c7'],
  ['#3c096c', '#7b2cbf', '#ffafcc'],
  ['#432818', '#99582a', '#ffe6a7']
]

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

function wrapTitle(title: string, maxChars: number, maxLines: number): string[] {
  const words = title.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length > maxChars && current.length > 0) {
      lines.push(current)
      current = word
      if (lines.length === maxLines) break
    } else {
      current = candidate
    }
  }
  if (current.length > 0 && lines.length < maxLines) lines.push(current)
  return lines.length > 0 ? lines : [title.slice(0, maxChars)]
}

function textLines(
  lines: string[],
  options: { x: number; y: number; size: number; lineHeight: number; fill: string; weight?: number }
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${options.x}" y="${options.y + index * options.lineHeight}" font-family="Segoe UI, Arial, sans-serif" font-size="${options.size}" font-weight="${options.weight ?? 700}" fill="${options.fill}">${escapeXml(line)}</text>`
    )
    .join('')
}

function mockSvg(kind: ArtworkKind, title: string, index: number, seed: string): {
  svg: string
  width: number
  height: number
} {
  const palette = PALETTES[hashText(seed) % PALETTES.length] ?? PALETTES[0]
  if (!palette) throw new Error('Paleta de demostración no disponible.')
  const [dark, mid, accent] = palette
  const safeTitle = escapeXml(title)
  const titleLines = wrapTitle(title, kind === 'logo' ? 18 : 22, kind === 'portrait' ? 3 : 2)

  if (kind === 'logo') {
    const width = 900
    const height = 300
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <g>
        <rect x="20" y="110" width="70" height="80" rx="14" fill="${accent}" opacity="0.95"/>
        <text x="38" y="166" font-family="Segoe UI, Arial, sans-serif" font-size="46" font-weight="800" fill="${dark}">EQ</text>
        ${textLines(titleLines, { x: 118, y: 132, size: 62, lineHeight: 68, fill: '#ffffff' })}
        <text x="120" y="244" font-family="Segoe UI, Arial, sans-serif" font-size="20" letter-spacing="6" fill="${accent}">DEMO ARTWORK</text>
      </g>
    </svg>`
    return { svg, width, height }
  }

  if (kind === 'icon') {
    const width = 256
    const height = 256
    const initials = title
      .split(/\s+/)
      .filter((word) => /\p{L}/u.test(word))
      .slice(0, 2)
      .map((word) => word[0]?.toLocaleUpperCase('es') ?? '')
      .join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>
      <rect width="256" height="256" rx="52" fill="url(#g)"/>
      <circle cx="198" cy="58" r="54" fill="${accent}" opacity="0.25"/>
      <path d="M32 188 L98 84 L150 160 L190 112 L224 188 Z" fill="${accent}" opacity="0.5"/>
      <text x="128" y="156" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="86" font-weight="800" fill="#ffffff">${escapeXml(initials || 'EQ')}</text>
    </svg>`
    return { svg, width, height }
  }

  if (kind === 'portrait') {
    const width = 600
    const height = 900
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dark}"/><stop offset="0.62" stop-color="${mid}"/></linearGradient>
        <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}" stop-opacity="0.9"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>
      </defs>
      <rect width="600" height="900" fill="url(#sky)"/>
      <circle cx="456" cy="188" r="86" fill="${accent}" opacity="0.9"/>
      <circle cx="438" cy="170" r="74" fill="${mid}" opacity="0.55"/>
      <path d="M0 690 L130 600 L250 668 L390 570 L600 706 L600 900 L0 900 Z" fill="${dark}" opacity="0.9"/>
      <path d="M0 770 L150 700 L300 760 L470 680 L600 748 L600 900 L0 900 Z" fill="#05070a" opacity="0.75"/>
      <polygon points="268,690 332,690 354,900 246,900" fill="${dark}"/>
      <polygon points="300,312 338,690 262,690" fill="#e9eef2" opacity="0.9"/>
      <polygon points="300,312 338,690 300,690" fill="#aab8c2" opacity="0.65"/>
      <rect x="272" y="300" width="56" height="46" fill="${accent}"/>
      <polygon points="300,306 600,238 600,320 300,334" fill="url(#beam)" opacity="0.75"/>
      <rect x="252" y="346" width="96" height="16" fill="#dbe7ef" opacity="0.8"/>
      ${textLines(titleLines, { x: 48, y: 792, size: 54, lineHeight: 60, fill: '#ffffff' })}
      <text x="50" y="858" font-family="Segoe UI, Arial, sans-serif" font-size="18" letter-spacing="5" fill="${accent}">FICTIONAL DEMO</text>
      <text x="600" y="40" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="16" letter-spacing="3" fill="#ffffff" opacity="0.65">MOCK</text>
    </svg>`
    return { svg, width, height }
  }

  if (kind === 'hero') {
    const width = 1920
    const height = 620
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${dark}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/></linearGradient>
        <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}" stop-opacity="0.85"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>
      </defs>
      <rect width="1920" height="620" fill="url(#bg)"/>
      <circle cx="1480" cy="170" r="150" fill="${accent}" opacity="0.35"/>
      <circle cx="1480" cy="170" r="96" fill="${accent}" opacity="0.55"/>
      <path d="M0 470 L220 398 L430 462 L690 350 L920 450 L1160 378 L1430 456 L1660 402 L1920 462 L1920 620 L0 620 Z" fill="#05070a" opacity="0.7"/>
      <polygon points="1580,230 1630,470 1510,470" fill="#e9eef2" opacity="0.9"/>
      <rect x="1540" y="214" width="58" height="40" fill="${accent}"/>
      <polygon points="1598,220 1920,126 1920,238 1598,258" fill="url(#glow)" opacity="0.7"/>
      ${textLines(titleLines, { x: 128, y: 350, size: 108, lineHeight: 120, fill: '#ffffff', weight: 800 })}
      <text x="134" y="500" font-family="Segoe UI, Arial, sans-serif" font-size="24" letter-spacing="8" fill="${accent}">A FICTIONAL DEMO ADVENTURE</text>
      <text x="1920" y="38" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="18" letter-spacing="4" fill="#ffffff" opacity="0.65">MOCK · ${index + 1}</text>
    </svg>`
    return { svg, width, height }
  }

  const width = 1280
  const height = 720
  const variant = hashText(`${seed}:${index}`) % 3
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#s)"/>
    <circle cx="${variant === 0 ? 930 : 260}" cy="150" r="${variant === 2 ? 96 : 132}" fill="${accent}" opacity="0.75"/>
    <path d="M0 500 L170 410 L330 486 L510 390 L720 492 L930 370 L1110 468 L1280 420 L1280 720 L0 720 Z" fill="#05070a" opacity="0.72"/>
    <path d="M0 580 L220 520 L430 572 L650 500 L860 590 L1080 518 L1280 560 L1280 720 L0 720 Z" fill="#020304" opacity="0.84"/>
    <polygon points="${variant === 1 ? 760 : 420},250 ${variant === 1 ? 830 : 490},548 ${variant === 1 ? 690 : 350},548" fill="#e9eef2" opacity="0.92"/>
    <rect x="${variant === 1 ? 742 : 402}" y="232" width="58" height="40" fill="${accent}"/>
    ${textLines(wrapTitle(`${title} · Escena ${index + 1}`, 26, 2), { x: 70, y: 638, size: 42, lineHeight: 48, fill: '#ffffff' })}
    <text x="70" y="70" font-family="Segoe UI, Arial, sans-serif" font-size="18" letter-spacing="5" fill="${accent}">SCREENSHOT DEMO</text>
    <text x="1210" y="70" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="16" letter-spacing="4" fill="#ffffff" opacity="0.6">MOCK</text>
  </svg>`
  return { svg, width, height }
}

interface RenderCache {
  dataUrl: string
  width: number
  height: number
}

export class MockMetadataProvider implements MetadataProvider {
  readonly info: MetadataProviderInfo = {
    id: 'mock',
    name: 'Proveedor de demostración',
    requiresKey: false,
    capabilities: {
      identity: true,
      details: true,
      artworkKinds: ['portrait', 'hero', 'logo', 'icon', 'screenshot'],
      descriptions: true,
      developers: true,
      publishers: true,
      releaseYear: true,
      screenshots: true
    },
    description:
      'Proveedor offline con juegos y arte de demostración originales. No realiza peticiones de red.',
    attribution: MOCK_ATTRIBUTION
  }

  private readonly language: MetadataLanguage
  private readonly now: () => Date
  private readonly artworkCache = new Map<string, Promise<RenderCache>>()

  constructor(options: { language?: MetadataLanguage; now?: () => Date } = {}) {
    this.language = options.language ?? 'es'
    this.now = options.now ?? (() => new Date())
  }

  isConfigured(): boolean {
    return true
  }

  async searchCandidates(
    query: string,
    _hints: SearchHints,
    signal?: AbortSignal
  ): Promise<ProviderCandidate[]> {
    this.throwIfAborted(signal)
    const wanted = normalizeTitle(query)
    if (wanted.length === 0) return []
    const wantedTokens = wanted.split(' ')
    return FIXTURES.filter((fixture) => {
      const searchable = normalizeTitle(`${fixture.searchTerms.join(' ')} ${fixture.es.title} ${fixture.en.title}`)
      return wantedTokens.every((token) => searchable.split(' ').includes(token))
    })
      .map((fixture) => this.candidate(fixture))
      .sort((left, right) => {
        const year = (left.releaseYear ?? 0) - (right.releaseYear ?? 0)
        return year !== 0 ? year : left.key.localeCompare(right.key)
      })
  }

  async getGame(providerId: string, options: { signal?: AbortSignal } = {}): Promise<GameMetadata> {
    this.throwIfAborted(options.signal)
    const fixture = FIXTURES.find((entry) => entry.id === providerId)
    if (!fixture) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'El juego de demostración solicitado no existe.', {
        details: { provider: 'mock', providerId }
      })
    }
    const text = this.language === 'es' ? fixture.es : fixture.en
    return {
      title: text.title,
      shortDescription: text.shortDescription,
      description: text.description,
      developers: ['Estudio Faro Norte (ficticio)'],
      publishers: ['Editora Bruma Local (ficticio)'],
      releaseDate: fixture.releaseDate,
      releaseYear: fixture.releaseYear,
      genres: [...text.genres],
      gameModes: [...text.gameModes],
      language: this.language,
      provider: this.info.id,
      providerId: fixture.id,
      fetchedAt: this.now().toISOString(),
      isMock: true
    }
  }

  async listArtwork(
    providerGameId: string,
    kind: ArtworkKind,
    options: ListArtworkOptions = {}
  ): Promise<ArtworkCandidate[]> {
    this.throwIfAborted(options.signal)
    const fixture = FIXTURES.find((entry) => entry.id === providerGameId)
    if (!fixture) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'El juego de demostración solicitado no existe.', {
        details: { provider: 'mock', providerId: providerGameId }
      })
    }
    const count = kind === 'screenshot' ? 2 : 1
    const candidates: ArtworkCandidate[] = []
    const text = this.language === 'es' ? fixture.es : fixture.en
    for (let index = 0; index < count; index += 1) {
      const render = await this.render(fixture.id, text.title, kind, index)
      candidates.push({
        provider: this.info.id,
        providerAssetId: `${fixture.id}:${kind}:${index + 1}`,
        providerGameId: fixture.id,
        kind,
        origin: 'mock',
        url: render.dataUrl,
        thumbUrl: render.dataUrl,
        width: render.width,
        height: render.height,
        mime: 'image/png',
        style: 'demo',
        language: this.language,
        author: 'BPSteamFit',
        attribution: MOCK_ATTRIBUTION,
        license: 'Arte original de BPSteamFit para demostración; no oficial.',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        isMock: true
      })
      if (options.limit !== undefined && candidates.length >= options.limit) break
    }
    return candidates
  }

  private candidate(fixture: MockGameFixture): ProviderCandidate {
    const text = this.language === 'es' ? fixture.es : fixture.en
    return {
      key: `${this.info.id}:${fixture.id}`,
      provider: this.info.id,
      providerId: fixture.id,
      title: text.title,
      releaseYear: fixture.releaseYear,
      edition: fixture.edition ?? null,
      isMock: true,
      tags: []
    }
  }

  private render(
    gameId: string,
    title: string,
    kind: ArtworkKind,
    index: number
  ): Promise<RenderCache> {
    const key = `${gameId}:${kind}:${index}`
    const cached = this.artworkCache.get(key)
    if (cached) return cached
    const pending = (async () => {
      const { svg, width, height } = mockSvg(kind, title, index, key)
      const { data, info } = await sharp(Buffer.from(svg))
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true })
      return {
        dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        width: info.width,
        height: info.height
      }
    })()
    this.artworkCache.set(key, pending)
    return pending
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AppError('METADATA_PROVIDER_FAILED', 'Consulta cancelada.', {
        details: { provider: 'mock', reason: 'aborted' }
      })
    }
  }
}
