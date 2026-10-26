import { safeStorage } from 'electron'
import { AppError } from '@shared/errors'
import type { SettingsRepository } from '@core/storage/settings-repository'

export const SECRET_STEAMGRIDDB = 'steamgriddb_api_key'

/**
 * Almacén de secretos de usuario. En Windows usa DPAPI vía safeStorage. Nunca
 * devuelve el valor a la UI y nunca escribe la clave en logs.
 */
export class SecretStore {
  constructor(private readonly repository: SettingsRepository) {}

  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  set(name: string, value: string): void {
    if (!this.isAvailable()) {
      throw new AppError(
        'SECRET_STORAGE_UNAVAILABLE',
        'Windows no ofrece almacenamiento cifrado para secretos en esta sesión. No se guardará la clave.'
      )
    }
    const normalized = value.trim()
    if (normalized.length < 8 || normalized.length > 512) {
      throw new AppError('SETTINGS_INVALID', 'La clave debe tener entre 8 y 512 caracteres.')
    }
    if (/[\u0000-\u001f\u007f]/.test(normalized) || /\s/.test(normalized)) {
      throw new AppError('SETTINGS_INVALID', 'La clave contiene caracteres no válidos.')
    }
    const encrypted = safeStorage.encryptString(normalized).toString('base64')
    this.repository.setSecret(name, encrypted)
  }

  get(name: string): string | null {
    const stored = this.repository.getSecret(name)
    if (!stored) return null
    if (!this.isAvailable()) {
      throw new AppError(
        'SECRET_STORAGE_UNAVAILABLE',
        'La clave guardada no se puede descifrar en esta sesión de Windows.'
      )
    }
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch (error) {
      throw new AppError(
        'SECRET_STORAGE_UNAVAILABLE',
        'No se pudo descifrar la clave guardada. Vuelve a configurarla.',
        { cause: error instanceof Error ? error.message : String(error) }
      )
    }
  }

  has(name: string): boolean {
    return this.repository.hasSecret(name)
  }

  delete(name: string): void {
    this.repository.deleteSecret(name)
  }
}
