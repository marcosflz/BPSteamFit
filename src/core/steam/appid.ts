import { AppError } from '@shared/errors'

/**
 * CRC32 IEEE 802.3. Es la variante que usa Steam para el AppID "heredado" de
 * los accesos directos externos. Se implementa aquí para no depender de zlib y
 * para que el cálculo sea idéntico en Node y en cualquier bundler.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function crc32Ieee(input: string | Uint8Array): number {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  let crc = 0xffffffff
  for (const byte of bytes) {
    const index = (crc ^ byte) & 0xff
    const tableValue = CRC32_TABLE[index]
    if (tableValue === undefined) throw new Error('Tabla CRC32 incompleta.')
    crc = tableValue ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export const SHORTCUT_APPID_HIGH_BIT = 0x80000000
export const STEAM_SHORTCUT_ID_MARKER = 0x02000000n

function validationError(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_ERROR', message, { details })
}

/** Añade comillas si no las lleva; Steam guarda normalmente \"ruta\". */
export function quoteSteamPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw validationError('La ruta de Steam no puede estar vacía.')
  }
  if (/[\u0000\r\n]/.test(path)) {
    throw validationError('La ruta de Steam contiene NUL o saltos de línea.')
  }
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    return path
  }
  if (path.includes('"')) {
    throw validationError('La ruta de Steam contiene comillas internas.', { path })
  }
  return `"${path}"`
}

export function unquoteSteamPath(field: string): string {
  if (field.length >= 2 && field.startsWith('"') && field.endsWith('"')) {
    return field.slice(1, -1)
  }
  return field
}

/**
 * AppID determinista de un acceso externo, calculado con la fórmula comunitaria
 * heredada: crc32(Exe + AppName) | 0x80000000, donde Exe es la cadena exacta
 * almacenada (normalmente entre comillas). Devuelve el valor sin signo.
 *
 * Limitación importante documentada en docs/steam.md: las versiones modernas de
 * Steam pueden asignar un AppID opaco al crear un acceso desde la interfaz.
 * Para entradas ya existentes SIEMPRE hay que leer el appid guardado en el VDF;
 * esta función solo sirve para proponer un ID determinista al crear uno nuevo.
 */
export function computeShortcutAppId(exePath: string, appName: string): number {
  return computeShortcutAppIdFromFields(quoteSteamPath(exePath), appName)
}

/** Igual que computeShortcutAppId, pero recibe el campo Exe tal cual se guarda. */
export function computeShortcutAppIdFromFields(exeField: string, appName: string): number {
  if (typeof appName !== 'string' || appName.length === 0) {
    throw validationError('El nombre del acceso no puede estar vacío.')
  }
  if (/[\u0000]/.test(exeField) || /[\u0000]/.test(appName)) {
    throw validationError('El AppID no se puede calcular sobre texto con NUL.')
  }
  return (crc32Ieee(exeField + appName) | SHORTCUT_APPID_HIGH_BIT) >>> 0
}

/** Convierte un AppID de 32 bits al int32 con signo que se escribe en el VDF. */
export function toSignedAppId(appId: number): number {
  if (!Number.isInteger(appId) || appId < 0 || appId > 0xffffffff) {
    throw validationError('El AppID debe ser un entero entre 0 y 4294967295.', { appId })
  }
  return appId | 0
}

/** Convierte el int32 del VDF (posiblemente negativo) al AppID sin signo. */
export function toUnsignedAppId(value: number | bigint): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isInteger(numeric) || numeric < -2_147_483_648 || numeric > 0xffffffff) {
    throw validationError('El appid del VDF está fuera del rango de 32 bits.', {
      value: typeof value === 'bigint' ? value.toString() : value
    })
  }
  return numeric >>> 0
}

export function isShortcutAppId(appId: number): boolean {
  return Number.isInteger(appId) && appId >= 0 && appId <= 0xffffffff &&
    (appId & SHORTCUT_APPID_HIGH_BIT) !== 0
}

/**
 * ID de 64 bits usado por steam://rungameid y por nombres de artwork antiguos.
 * No se usa para nombrar el artwork actual: ese usa el AppID de 32 bits.
 */
export function getSteamLaunchId(appId: number): bigint {
  const unsigned = toUnsignedAppId(appId)
  return (BigInt(unsigned) << 32n) | STEAM_SHORTCUT_ID_MARKER
}

export function formatSteamLaunchId(appId: number): string {
  return getSteamLaunchId(appId).toString()
}

export type SteamArtworkKind = 'portrait' | 'hero' | 'logo' | 'icon'

export const STEAM_ARTWORK_KINDS: readonly SteamArtworkKind[] = [
  'portrait',
  'hero',
  'logo',
  'icon'
]

/**
 * Extensiones aceptadas para el artwork local. Steam lee PNG y JPEG; no se
 * promete WebP/TGA porque no está verificado en este proyecto.
 */
export const STEAM_ARTWORK_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

export type SteamArtworkExtension = (typeof STEAM_ARTWORK_EXTENSIONS)[number]

export function normalizeArtworkExtension(extension: string): '.png' | '.jpg' {
  const lower = extension.toLowerCase()
  if (lower === '.png') return '.png'
  if (lower === '.jpg' || lower === '.jpeg') return '.jpg'
  throw new AppError('ARTWORK_INVALID', `Extensión de artwork no soportada: ${extension}`, {
    details: { extension, supported: [...STEAM_ARTWORK_EXTENSIONS] }
  })
}

function artworkSuffix(kind: SteamArtworkKind): string {
  switch (kind) {
    case 'portrait':
      return 'p'
    case 'hero':
      return '_hero'
    case 'logo':
      return '_logo'
    case 'icon':
      return '_icon'
  }
}

/**
 * Nombre canónico en config/grid. Se usa el AppID sin signo, no el ID de 64
 * bits ni el appid con signo. Ejemplo: 2443196458p.png.
 */
export function getArtworkFileName(
  appId: number,
  kind: SteamArtworkKind,
  extension: string = '.png'
): string {
  const unsigned = toUnsignedAppId(appId)
  if (unsigned === 0) {
    throw new AppError('ARTWORK_INVALID', 'El AppID 0 no es válido para artwork.')
  }
  const normalized = normalizeArtworkExtension(extension)
  return `${unsigned}${artworkSuffix(kind)}${normalized}`
}

export function getArtworkFileStem(appId: number, kind: SteamArtworkKind): string {
  return getArtworkFileName(appId, kind, '.png').slice(0, -'.png'.length)
}

export interface AllocatedShortcutAppId {
  appId: number
  source: 'legacy-crc' | 'collision-fallback'
}

/**
 * Propone un AppID libre. Primero usa la fórmula heredada; si colisiona con
 * cualquier entrada existente (ajena o gestionada), usa un hash de respaldo
 * determinista con sal. El respaldo no es el algoritmo de Steam; está pensado
 * para no pisar jamás un AppID ajeno y se documenta como tal.
 */
export function allocateShortcutAppId(
  exePath: string,
  appName: string,
  occupied: Iterable<number>,
  options: { salt?: string; maxAttempts?: number } = {}
): AllocatedShortcutAppId {
  const used = new Set<number>()
  for (const appId of occupied) used.add(toUnsignedAppId(appId))
  const quotedExe = quoteSteamPath(exePath)
  const legacy = computeShortcutAppIdFromFields(quotedExe, appName)
  if (!used.has(legacy)) return { appId: legacy, source: 'legacy-crc' }

  const salt = options.salt ?? 'bpsf'
  const maxAttempts = options.maxAttempts ?? 1000
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate =
      (crc32Ieee(`${quotedExe}\u0000${appName}\u0000${salt}\u0000${attempt}`) |
        SHORTCUT_APPID_HIGH_BIT) >>>
      0
    if (!used.has(candidate)) return { appId: candidate, source: 'collision-fallback' }
  }
  throw new AppError('STEAM_SYNC_FAILED', 'No se pudo asignar un AppID libre al acceso externo.')
}
