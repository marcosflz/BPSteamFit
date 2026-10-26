import type { ErrorCode, SerializedAppError } from '@shared/errors'

export interface UiError {
  code: string
  message: string
  hint?: string
  details?: Record<string, unknown>
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  PACKAGE_NOT_FOUND: 'Comprueba que el archivo .game siga en una carpeta de paquetes y actualiza el catálogo.',
  PACKAGE_UNAVAILABLE: 'Actualiza el catálogo o vuelve a añadir la carpeta que contiene el paquete.',
  PACKAGE_CORRUPT: 'Vuelve a copiar el paquete original; el archivo está dañado o incompleto.',
  PACKAGE_INVALID: 'Revisa el manifiesto del paquete con el generador; la app no puede instalarlo.',
  PACKAGE_INTEGRITY_MISMATCH: 'El paquete cambió desde que se importó. Actualiza el catálogo y vuelve a intentarlo.',
  INSTALL_BUSY: 'Espera a que termine la operación de instalación en curso.',
  INSTALL_INVALID_STATE: 'Actualiza el estado de la instalación y vuelve a intentarlo.',
  INSTALL_ELEVATION_REQUIRED: 'El escritorio seguro de UAC no se puede controlar con el mando. Ejecuta el setup manualmente y luego comprueba la instalación.',
  INSTALL_NOT_ENOUGH_SPACE: 'Libera espacio en el disco temporal o en el destino y vuelve a intentarlo.',
  INSTALL_VERIFY_FAILED: 'El instalador terminó pero faltan archivos. Revisa el log y ejecuta la comprobación de nuevo.',
  INSTALL_INTERRUPTED: 'La app se cerró durante la instalación. Comprueba los archivos instalados antes de reintentar.',
  METADATA_AUTH_REQUIRED: 'Configura una clave válida de SteamGridDB en Ajustes.',
  METADATA_RATE_LIMITED: 'Espera unos minutos antes de volver a buscar metadatos.',
  METADATA_OFFLINE: 'Comprueba la conexión a Internet o usa el proveedor de demostración.',
  ARTWORK_INVALID: 'Elige un archivo de imagen válido (PNG, JPG o WebP).',
  ARTWORK_TOO_LARGE: 'Usa una imagen más pequeña.',
  STEAM_NOT_FOUND: 'Comprueba que Steam está instalado en este equipo y actualiza el estado.',
  STEAM_PROFILE_NOT_FOUND: 'Inicia sesión en Steam al menos una vez para que exista un perfil.',
  STEAM_BUSY: 'Cierra Steam manualmente y vuelve a preparar la sincronización.',
  STEAM_SHUTDOWN_FAILED: 'Steam no se cerró. Ciérralo manualmente antes de sincronizar.',
  STEAM_VDF_INVALID: 'La biblioteca de Steam no se pudo leer. Se conserva el backup; revisa la carpeta de logs.',
  SECRET_STORAGE_UNAVAILABLE: 'El almacenamiento seguro del sistema no está disponible; no se guardará la clave.',
  SETTINGS_INVALID: 'Revisa la carpeta elegida; debe ser una ruta absoluta válida.',
  IO_ERROR: 'Comprueba los permisos de la carpeta y vuelve a intentarlo.',
  DATABASE_ERROR: 'Vuelve a abrir la app. Si persiste, revisa la carpeta de logs.'
}

export function toUiError(value: unknown): UiError {
  const candidate = value as
    | { code?: unknown; message?: unknown; details?: unknown }
    | null
    | undefined
  const rawCode = typeof candidate?.code === 'string' ? candidate.code : 'UNKNOWN'
  const code = rawCode || 'UNKNOWN'
  const message =
    typeof candidate?.message === 'string' && candidate.message.trim()
      ? candidate.message
      : 'La operación no se pudo completar.'
  const details = sanitizeDetails(candidate?.details)
  const hint = HINTS[code as ErrorCode]
  return { code, message, hint, details }
}

export function fromSerializedError(error: SerializedAppError | undefined | null): UiError | null {
  if (!error) return null
  return toUiError(error)
}

const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|credential|authorization|cookie|session|clave|contrase(ñ|n)a|^key$/i

/** Prepara detalles técnicos para mostrarlos sin exponer secretos ni objetos enormes. */
export function sanitizeDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined
  const sanitized = sanitizeRecord(value, 0)
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null
  if (typeof value === 'string') {
    return value.length > 400 ? `${value.slice(0, 397)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= 3) return `[${value.length} elementos]`
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (isPlainRecord(value)) {
    if (depth >= 3) return '[objeto]'
    return sanitizeRecord(value, depth + 1)
  }
  return String(value)
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let count = 0
  for (const [key, entry] of Object.entries(value)) {
    if (count >= 30) break
    if (SENSITIVE_KEY.test(key)) continue
    if (entry === undefined) continue
    result[key] = sanitizeValue(entry, depth)
    count += 1
  }
  return result
}

export function detailsText(error: UiError): string | null {
  if (!error.details) return null
  try {
    return JSON.stringify(error.details, null, 2)
  } catch {
    return null
  }
}
