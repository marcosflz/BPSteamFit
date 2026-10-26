import type { AppSettings } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { AppDatabase } from './database'
import { defaultSettings } from './types'

const SETTING_KEYS: Array<keyof AppSettings> = [
  'packageFolders',
  'installationRoot',
  'metadataProvider',
  'referToMetadataInSpanish',
  'selectedSteamAccountId',
  'onboardingCompleted'
]

export class SettingsRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly homeDirectory: string
  ) {}

  get(): AppSettings {
    const defaults = defaultSettings(this.homeDirectory)
    const rows = this.database
      .prepare('SELECT key, value_json FROM settings')
      .all() as unknown as Array<{ key: string; value_json: string }>
    const stored = new Map(rows.map((row) => [row.key, row.value_json]))
    const result: AppSettings = { ...defaults }
    for (const key of SETTING_KEYS) {
      const raw = stored.get(key)
      if (!raw) continue
      try {
        const value = JSON.parse(raw) as unknown
        // Se valida de forma mínima; el servicio de ajustes hace la validación
        // completa antes de escribir. Un valor corrupto cae al default.
        if (key === 'packageFolders' && Array.isArray(value) && value.every((x) => typeof x === 'string')) {
          result.packageFolders = value
        } else if (key === 'installationRoot' && typeof value === 'string') {
          result.installationRoot = value
        } else if (key === 'metadataProvider' && (value === 'mock' || value === 'steamgriddb')) {
          result.metadataProvider = value
        } else if (key === 'referToMetadataInSpanish' && typeof value === 'boolean') {
          result.referToMetadataInSpanish = value
        } else if (key === 'selectedSteamAccountId' && typeof value === 'string') {
          result.selectedSteamAccountId = value
        } else if (key === 'onboardingCompleted' && typeof value === 'boolean') {
          result.onboardingCompleted = value
        }
      } catch {
        // Valor corrupto: se ignora y se mantiene el default.
      }
    }
    return result
  }

  save(settings: AppSettings): void {
    const now = new Date().toISOString()
    this.database.transaction(() => {
      for (const key of SETTING_KEYS) {
        const value = settings[key]
        if (value === undefined) {
          this.database.prepare('DELETE FROM settings WHERE key = ?').run(key)
          continue
        }
        this.database
          .prepare(
            `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
          )
          .run(key, JSON.stringify(value), now)
      }
    })
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.get()
    const next: AppSettings = { ...current, ...patch }
    this.save(next)
    return this.get()
  }

  setSecret(name: string, encryptedBase64: string): void {
    this.database
      .prepare(
        `INSERT INTO secrets (name, value_encrypted, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`
      )
      .run(name, encryptedBase64, new Date().toISOString())
  }

  getSecret(name: string): string | null {
    const row = this.database
      .prepare('SELECT value_encrypted FROM secrets WHERE name = ?')
      .get(name) as unknown as { value_encrypted: string } | undefined
    return row?.value_encrypted ?? null
  }

  deleteSecret(name: string): void {
    this.database.prepare('DELETE FROM secrets WHERE name = ?').run(name)
  }

  hasSecret(name: string): boolean {
    return Boolean(this.getSecret(name))
  }

  assertValidSettings(settings: AppSettings): void {
    if (settings.packageFolders.some((folder) => typeof folder !== 'string' || folder.trim().length === 0)) {
      throw new AppError('SETTINGS_INVALID', 'Las carpetas de paquetes no son válidas.')
    }
    if (!settings.installationRoot || !settings.installationRoot.trim()) {
      throw new AppError('SETTINGS_INVALID', 'Falta la carpeta de instalación de juegos.')
    }
    if (settings.metadataProvider !== 'mock' && settings.metadataProvider !== 'steamgriddb') {
      throw new AppError('SETTINGS_INVALID', 'Proveedor de metadatos no válido.')
    }
  }
}
