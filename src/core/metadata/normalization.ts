/**
 * Normalización de títulos para comparación heurística. No se usa para
 * mostrar texto: la vista conserva el título original del proveedor.
 *
 * Reglas deliberadas:
 * - Se ignoran mayúsculas y diacríticos al comparar, pero nunca se borran
 *   números de secuela, subtítulos ni tokens como "remake"/"remaster".
 * - Las ediciones se detectan aparte para puntuarlas, sin reescribir el
 *   título almacenado.
 */

export type EditionTag =
  | 'deluxe'
  | 'ultimate'
  | 'definitive'
  | 'gold'
  | 'complete'
  | 'collector'
  | 'goty'
  | 'enhanced'
  | 'directors-cut'
  | 'anniversary'
  | 'legendary'
  | 'premium'
  | 'special'
  | 'limited'
  | 'standard'
  | 'digital'

export type VariantTag = 'remake' | 'remaster'

export interface ParsedTitle {
  raw: string
  /** Texto plegado: minúsculas, sin diacríticos ni puntuación. */
  normalized: string
  /** Como `normalized`, sin las frases de edición. */
  core: string
  tokens: string[]
  editions: EditionTag[]
  variants: VariantTag[]
  /** Números de secuela detectados, normalizados a arábigo. */
  sequelNumbers: number[]
}

const COMBINING_MARKS = /\p{M}+/gu
const APOSTROPHES = /[\u2018\u2019\u201b\u02bc\u0060\u00b4]/g
const DASHES = /[\u2010-\u2015\u2212]/g
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL, ' ')
}

/** Comparación insensible a mayúsculas, acentos y ancho Unicode. */
export function foldComparisonText(value: string): string {
  return stripControlCharacters(value)
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
}

export function normalizeTitle(value: string): string {
  return foldComparisonText(value)
    .replace(APOSTROPHES, ' ')
    .replace(DASHES, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const EDITION_PATTERNS: ReadonlyArray<{ tag: EditionTag; pattern: RegExp }> = [
  {
    tag: 'goty',
    pattern: /\b(?:game of the year|juego del anio|juego del año|goty)\b/gu
  },
  {
    tag: 'directors-cut',
    pattern: /\b(?:director s cut|directors cut|director's cut|corte del director)\b/gu
  },
  {
    tag: 'collector',
    pattern: /\b(?:collector s|collectors|collector's|collector|coleccionista)\b/gu
  },
  { tag: 'deluxe', pattern: /\b(?:deluxe|de lujo)\b/gu },
  { tag: 'ultimate', pattern: /\b(?:ultimate|ultima|última)\b/gu },
  { tag: 'definitive', pattern: /\b(?:definitive|definitiva|definitivo)\b/gu },
  { tag: 'complete', pattern: /\b(?:complete|completa|completo)\b/gu },
  { tag: 'gold', pattern: /\b(?:gold|dorada|dorado|oro)\b/gu },
  { tag: 'enhanced', pattern: /\b(?:enhanced|mejorada|mejorado)\b/gu },
  { tag: 'anniversary', pattern: /\b(?:anniversary|aniversario)\b/gu },
  { tag: 'legendary', pattern: /\b(?:legendary|legendaria|legendario)\b/gu },
  { tag: 'premium', pattern: /\bpremium\b/gu },
  { tag: 'special', pattern: /\b(?:special|especial)\b/gu },
  { tag: 'limited', pattern: /\b(?:limited|limitada|limitado)\b/gu },
  { tag: 'standard', pattern: /\b(?:standard|estandar|estándar)\b/gu },
  { tag: 'digital', pattern: /\b(?:digital|digitals)\b/gu }
]

const VARIANT_PATTERNS: ReadonlyArray<{ tag: VariantTag; pattern: RegExp }> = [
  { tag: 'remake', pattern: /\bremakes?\b/gu },
  { tag: 'remaster', pattern: /\b(?:remaster|remastered|remasterizad[oa]|remasterizacion)\b/gu }
]

const EDITION_PHRASE = new RegExp(
  [
    '\\b(?:game of the year|juego del anio|juego del año|goty)(?:\\s+(?:edition|version|edicion|edición))?',
    '\\b(?:director s cut|directors cut|corte del director)',
    '\\b(?:collector s|collectors|collector|coleccionista)(?:\\s+(?:edition|version|edicion|edición))?',
    '\\b(?:deluxe|de lujo|ultimate|ultima|última|definitive|definitiva|definitivo|complete|completa|completo|gold|dorada|dorado|oro|enhanced|mejorada|mejorado|anniversary|aniversario|legendary|legendaria|legendario|premium|special|especial|limited|limitada|limitado|standard|estandar|estándar|digital|digitals)(?:\\s+(?:edition|version|edicion|edición))?',
    '\\b(?:edition|version|edicion|edición)\\b'
  ].join('|'),
  'gu'
)

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9
}

const SEQUEL_CONTEXT = new Set(['part', 'parte', 'chapter', 'capitulo', 'capítulo', 'episode', 'episodio', 'vol', 'volume', 'book', 'libro'])

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function detectTags<T extends string>(
  normalized: string,
  patterns: ReadonlyArray<{ tag: T; pattern: RegExp }>
): T[] {
  const found: T[] = []
  for (const { tag, pattern } of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(normalized)) found.push(tag)
  }
  return unique(found)
}

function stripEditionPhrases(normalized: string): string {
  return normalized
    .replace(EDITION_PHRASE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function detectSequelNumbers(tokens: string[]): number[] {
  const numbers: number[] = []
  tokens.forEach((token, index) => {
    const roman = ROMAN_VALUES[token]
    if (roman !== undefined) {
      const previous = index > 0 ? tokens[index - 1] : undefined
      if (index > 0 || SEQUEL_CONTEXT.has(previous ?? '')) {
        numbers.push(roman)
      }
      return
    }
    if (!/^\d{1,2}$/.test(token)) return
    const parsed = Number.parseInt(token, 10)
    if (parsed >= 1 && parsed <= 99) numbers.push(parsed)
  })
  return unique(numbers)
}

export function parseTitle(value: string): ParsedTitle {
  const normalized = normalizeTitle(value)
  const tokens = normalized.length > 0 ? normalized.split(' ') : []
  return {
    raw: value,
    normalized,
    core: stripEditionPhrases(normalized),
    tokens,
    editions: detectTags(normalized, EDITION_PATTERNS),
    variants: detectTags(normalized, VARIANT_PATTERNS),
    sequelNumbers: detectSequelNumbers(tokens)
  }
}

/** Igualdad de título plegado, incluidas edición y variantes. */
export function titlesEqual(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b)
}

function diceCoefficient<T>(left: Set<T>, right: Set<T>): number {
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) {
    if (right.has(value)) intersection += 1
  }
  return (2 * intersection) / (left.size + right.size)
}

function bigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length < 2) return new Set(compact.length === 1 ? [compact] : [])
  const result = new Set<string>()
  for (let index = 0; index < compact.length - 1; index += 1) {
    result.add(compact.slice(index, index + 2))
  }
  return result
}

/**
 * Similitud heurística 0..1 (no es una probabilidad). Combina tokens y
 * bigramas y premia que el título corto esté contenido en el largo, sin
 * eliminar números ni palabras de edición.
 */
export function titleSimilarity(left: string, right: string): number {
  const a = parseTitle(left)
  const b = parseTitle(right)
  if (a.normalized.length === 0 || b.normalized.length === 0) return 0
  if (a.normalized === b.normalized) return 1

  const tokenScore = diceCoefficient(new Set(a.tokens), new Set(b.tokens))
  const bigramScore = diceCoefficient(bigrams(a.normalized), bigrams(b.normalized))
  const shorter = a.tokens.length <= b.tokens.length ? a.tokens : b.tokens
  const longer = new Set(a.tokens.length <= b.tokens.length ? b.tokens : a.tokens)
  const contained = shorter.length > 0 && shorter.every((token) => longer.has(token))
  const containmentScore = contained ? 0.85 + 0.1 * (shorter.length / longer.size) : 0

  return Math.min(1, Math.max(tokenScore * 0.9, bigramScore * 0.75, containmentScore))
}

export function editionsEqual(left: ParsedTitle, right: ParsedTitle): boolean {
  const a = [...left.editions].sort().join(',')
  const b = [...right.editions].sort().join(',')
  return a === b
}

export function variantsEqual(left: ParsedTitle, right: ParsedTitle): boolean {
  const a = [...left.variants].sort().join(',')
  const b = [...right.variants].sort().join(',')
  return a === b
}

export function sequelNumbersEqual(left: ParsedTitle, right: ParsedTitle): boolean {
  const a = [...left.sequelNumbers].sort((x, y) => x - y).join(',')
  const b = [...right.sequelNumbers].sort((x, y) => x - y).join(',')
  return a === b
}
