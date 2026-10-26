import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, SettingsPatch } from '@shared/domain'
import { AppError } from '@shared/errors'
import { validateLocalAbsolutePath } from '@shared/safe-path'
import type { SettingsRepository } from '../storage/settings-repository'

export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}

  get(): AppSettings {
    return this.repository.get()
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    if (patch.packageFolders) {
      const normalized: string[] = []
      for (const folder of patch.packageFolders) {
        if (typeof folder !== 'string' || !folder.trim()) {
          throw new AppError('SETTINGS_INVALID', 'La carpeta de paquetes no es válida.')
        }
        const checked = validateLocalAbsolutePath(folder, 'La carpeta de paquetes')
        if (!checked.ok) {
          throw new AppError('SETTINGS_INVALID', checked.reason)
        }
        const absolute = checked.value
        if (!normalized.some((existing) => existing.toLowerCase() === absolute.toLowerCase())) {
          normalized.push(absolute)
        }
      }
      patch = { ...patch, packageFolders: normalized }
    }
    if (patch.installationRoot) {
      const checked = validateLocalAbsolutePath(patch.installationRoot, 'La carpeta de juegos')
      if (!checked.ok) {
        throw new AppError('SETTINGS_INVALID', checked.reason)
      }
      patch = { ...patch, installationRoot: checked.value }
    }
    if (patch.metadataProvider && !['mock', 'steamgriddb'].includes(patch.metadataProvider)) {
      throw new AppError('SETTINGS_INVALID', 'Proveedor de metadatos no válido.')
    }

    const current = this.repository.get()
    const next = { ...current, ...patch }
    this.repository.assertValidSettings(next)
    await mkdir(next.installationRoot, { recursive: true })
    for (const folder of next.packageFolders) await mkdir(folder, { recursive: true })
    return this.repository.update(next)
  }

  async addPackageFolder(folder: string): Promise<AppSettings> {
    const absolute = path.resolve(folder)
    const current = this.repository.get()
    if (current.packageFolders.some((existing) => existing.toLowerCase() === absolute.toLowerCase())) {
      return current
    }
    return this.update({ packageFolders: [...current.packageFolders, absolute] })
  }

  async chooseInstallationRoot(folder: string): Promise<AppSettings> {
    return this.update({ installationRoot: path.resolve(folder) })
  }
}
