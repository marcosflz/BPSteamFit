/**
 * Errores tipados compartidos por el proceso principal, el CLI y (como forma
 * serializable) la interfaz. Nunca se envía al renderer el stack ni secretos.
 */
export type ErrorCode =
  | 'MANIFEST_INVALID'
  | 'MANIFEST_UNSUPPORTED_VERSION'
  | 'PACKAGE_NOT_FOUND'
  | 'PACKAGE_UNREADABLE'
  | 'PACKAGE_CORRUPT'
  | 'PACKAGE_INVALID'
  | 'PACKAGE_DUPLICATE'
  | 'PACKAGE_VERSION_CONFLICT'
  | 'PACKAGE_INTEGRITY_MISMATCH'
  | 'PACKAGE_UNAVAILABLE'
  | 'EXTRACT_UNSAFE'
  | 'EXTRACT_LIMIT'
  | 'EXTRACT_CANCELLED'
  | 'EXTRACT_FAILED'
  | 'INSTALL_BUSY'
  | 'INSTALL_INVALID_STATE'
  | 'INSTALL_CONFIRMATION_REQUIRED'
  | 'INSTALL_DEST_UNSAFE'
  | 'INSTALL_NOT_ENOUGH_SPACE'
  | 'INSTALL_PROCESS_FAILED'
  | 'INSTALL_EXIT_CODE'
  | 'INSTALL_VERIFY_FAILED'
  | 'INSTALL_CANCELLED'
  | 'INSTALL_ELEVATION_REQUIRED'
  | 'INSTALL_INTERRUPTED'
  | 'METADATA_PROVIDER_FAILED'
  | 'METADATA_AUTH_REQUIRED'
  | 'METADATA_RATE_LIMITED'
  | 'METADATA_OFFLINE'
  | 'METADATA_INVALID_RESPONSE'
  | 'ARTWORK_INVALID'
  | 'ARTWORK_DOWNLOAD_FAILED'
  | 'ARTWORK_TOO_LARGE'
  | 'STEAM_NOT_FOUND'
  | 'STEAM_PROFILE_NOT_FOUND'
  | 'STEAM_VDF_INVALID'
  | 'STEAM_BUSY'
  | 'STEAM_SHUTDOWN_FAILED'
  | 'STEAM_SYNC_FAILED'
  | 'STEAM_BACKUP_FAILED'
  | 'SECRET_STORAGE_UNAVAILABLE'
  | 'SETTINGS_INVALID'
  | 'DATABASE_ERROR'
  | 'IO_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN'

export interface SerializedAppError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>
  override readonly cause?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = options.details
    this.cause = options.cause
  }

  toJSON(): SerializedAppError {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

export function toAppError(
  value: unknown,
  fallbackCode: ErrorCode = 'UNKNOWN',
  fallbackMessage = 'Se produjo un error inesperado.'
): AppError {
  if (isAppError(value)) return value
  if (value instanceof Error) {
    return new AppError(fallbackCode, fallbackMessage, { cause: value.message })
  }
  return new AppError(fallbackCode, fallbackMessage, { cause: String(value) })
}

/** Convierte un error en datos seguros para IPC o para el resultado del CLI. */
export function serializeError(value: unknown): SerializedAppError {
  const error = toAppError(value)
  return error.toJSON()
}
