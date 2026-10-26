/**
 * Validación central de rutas relativas. Se usa tanto con manifiestos como con
 * entradas ZIP. No sustituye la comprobación final contra el directorio
 * canónico después de extraer/escribir.
 */
import path from 'node:path'

const WINDOWS_RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

// C0/C1, separadores de línea, y controles bidireccionales que permiten
// disfrazar extensiones o rutas. Se rechazan en lugar de "limpiarse".
const UNSAFE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*]/

export type PathCheck =
  | { ok: true; value: string }
  | { ok: false; reason: string }

export interface RelativePathOptions {
  /** Descripción usada en los mensajes de error. */
  label?: string
  /** Si se permite la cadena vacía (por ejemplo, un directorio de trabajo raíz). */
  allowEmpty?: boolean
  /** Máximo de caracteres del nombre completo. */
  maxLength?: number
}

/**
 * Valida una ruta relativa con separadores `/`, adecuada para un manifiesto o
 * una entrada ZIP. Rechaza rutas absolutas, UNC, unidades, dispositivos,
 * segmentos `.`/`..`, nombres reservados de Windows y caracteres de control.
 */
export function checkRelativePath(input: string, options: RelativePathOptions = {}): PathCheck {
  const label = options.label ?? 'La ruta'
  const maxLength = options.maxLength ?? 1024
  if (typeof input !== 'string') return { ok: false, reason: `${label} debe ser texto.` }
  if (input.length === 0) {
    return options.allowEmpty
      ? { ok: true, value: '' }
      : { ok: false, reason: `${label} no puede estar vacía.` }
  }
  if (input.length > maxLength) {
    return { ok: false, reason: `${label} supera el máximo de ${maxLength} caracteres.` }
  }
  if (input.startsWith('/') || input.startsWith('\\')) {
    return { ok: false, reason: `${label} no puede ser absoluta ni UNC.` }
  }
  if (/^[a-zA-Z]:/.test(input)) {
    return { ok: false, reason: `${label} no puede incluir una unidad (por ejemplo C:).` }
  }
  if (/^[\\/]{2}/.test(input) || /^\\\\[?.]\\/.test(input)) {
    return { ok: false, reason: `${label} no puede ser una ruta UNC o de dispositivo.` }
  }
  if (input.includes('\\')) {
    return { ok: false, reason: `${label} debe usar / como separador, no \\\\.` }
  }
  if (input.includes('//')) {
    return { ok: false, reason: `${label} contiene un segmento vacío.` }
  }
  if (UNSAFE_CONTROL_CHARS.test(input)) {
    return { ok: false, reason: `${label} contiene caracteres de control no permitidos.` }
  }

  const segments = input.split('/')
  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: `${label} contiene un segmento vacío.` }
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: `${label} no puede contener . ni ...` }
    }
    if (segment.length > 255) {
      return { ok: false, reason: `${label} contiene un segmento demasiado largo.` }
    }
    if (WINDOWS_FORBIDDEN_CHARS.test(segment)) {
      return { ok: false, reason: `${label} contiene caracteres no válidos en Windows.` }
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      return {
        ok: false,
        reason: `${label} no puede tener segmentos que terminen en espacio o punto.`
      }
    }
    if (WINDOWS_RESERVED_NAMES.test(segment)) {
      return { ok: false, reason: `${label} usa un nombre reservado de Windows: ${segment}` }
    }
  }

  return { ok: true, value: segments.join('/') }
}

/** Devuelve la ruta normalizada o lanza un error de validación. */
export function assertRelativePath(input: string, label = 'La ruta'): string {
  const checked = checkRelativePath(input, { label })
  if (!checked.ok) throw new Error(checked.reason)
  return checked.value
}

/**
 * Construye un nombre de carpeta seguro para una instalación. No se usa para
 * resolver rutas del paquete, solo para proponer un destino.
 */
export function slugifyGameId(id: string, fallback = 'juego'): string {
  const ascii = id
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80)
  const candidate = ascii.length > 0 ? ascii : fallback
  if (WINDOWS_RESERVED_NAMES.test(candidate)) return `game-${candidate}`
  return candidate
}

/**
 * Valida una ruta absoluta local de Windows destinada a escritura/instalación.
 * Rechaza rutas extendidas, UNC, unidades relativas, nombres reservados y
 * segmentos con punto/espacio final, que Windows puede aliasar.
 */
export function validateLocalAbsolutePath(
  input: string,
  label = 'La ruta'
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: `${label} no puede estar vacía.` }
  }
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return { ok: false, reason: `${label} contiene caracteres de control.` }
  }
  if (input !== input.trim()) {
    return { ok: false, reason: `${label} no puede empezar o terminar con espacios.` }
  }
  const slashed = input.replace(/\//g, '\\')
  if (/^\\\\[?.]\\/.test(slashed) || /^\\\\\.\\/.test(slashed)) {
    return { ok: false, reason: `${label} no puede usar rutas extendidas o de dispositivo.` }
  }
  if (/^\\\\/.test(slashed)) {
    return { ok: false, reason: `${label} debe ser una ruta local con letra de unidad; no se admite UNC.` }
  }
  if (!/^[a-zA-Z]:\\/.test(slashed)) {
    return { ok: false, reason: `${label} debe ser una ruta absoluta con letra de unidad.` }
  }
  const withoutDrive = slashed.slice(2)
  const segments = withoutDrive.split('\\')
  for (const segment of segments) {
    if (segment.length === 0) continue
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: `${label} no puede contener . ni ..` }
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { ok: false, reason: `${label} contiene segmentos terminados en punto o espacio.` }
    }
    if (WINDOWS_FORBIDDEN_CHARS.test(segment)) {
      return { ok: false, reason: `${label} contiene caracteres no válidos en Windows.` }
    }
    if (WINDOWS_RESERVED_NAMES.test(segment)) {
      return { ok: false, reason: `${label} usa un nombre reservado de Windows: ${segment}` }
    }
  }
  if (path.win32.parse(path.win32.normalize(slashed)).root === path.win32.normalize(slashed)) {
    return { ok: false, reason: `${label} no puede ser la raíz de una unidad.` }
  }
  return { ok: true, value: path.win32.normalize(slashed) }
}

/**
 * Comprueba si una ruta absoluta resuelta queda realmente dentro de una base.
 * La comparación es case-insensitive en Windows para evitar bypasses.
 */
export function isPathInside(base: string, candidate: string, platform = process.platform): boolean {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix
  const normalize = (value: string): string => {
    const cleaned = pathImpl.resolve(value).replace(/[\\/]+/g, '\\').replace(/\\$/, '')
    return platform === 'win32' ? cleaned.toLowerCase() : cleaned
  }
  const normalizedBase = normalize(base)
  const normalizedCandidate = normalize(candidate)
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(normalizedBase + '\\')
  )
}
