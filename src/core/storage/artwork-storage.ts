import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { checkRelativePath, isPathInside } from '@shared/safe-path'
import type { ArtworkStorage, ArtworkStorageInfo, StoredArtworkBlob } from '../artwork/types'

/**
 * Guarda originales y variantes de artwork bajo la carpeta gestionada de la
 * app. Nunca escribe fuera de ella y no borra originales al cambiar una
 * selección.
 */
export class FileArtworkStorage implements ArtworkStorage {
  constructor(private readonly root: string) {}

  private resolveKey(key: string): string {
    const checked = checkRelativePath(key, { label: 'La clave de artwork', maxLength: 512 })
    if (!checked.ok) {
      throw new AppError('ARTWORK_INVALID', checked.reason)
    }
    const base = path.resolve(this.root)
    const target = path.resolve(base, ...checked.value.split('/'))
    if (!isPathInside(base, target)) {
      throw new AppError('ARTWORK_INVALID', 'La clave de artwork escapó de la carpeta permitida.')
    }
    return target
  }

  async put(
    key: string,
    bytes: Uint8Array,
    info: ArtworkStorageInfo
  ): Promise<StoredArtworkBlob> {
    const target = this.resolveKey(key)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    } catch (error) {
      await import('node:fs/promises')
        .then((fs) => fs.rm(temporary, { force: true }))
        .catch(() => undefined)
      throw new AppError('IO_ERROR', 'No se pudo escribir el artwork.', {
        cause: error instanceof Error ? error.message : String(error),
        details: { key, width: info.width, height: info.height }
      })
    }
    return { key }
  }

  /** Resuelve una clave ya guardada para el protocolo de medios. */
  async resolveFile(key: string): Promise<string | null> {
    try {
      const target = this.resolveKey(key)
      const info = await stat(target)
      return info.isFile() ? target : null
    } catch {
      return null
    }
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key))
  }

  async exists(key: string): Promise<boolean> {
    return (await this.resolveFile(key)) !== null
  }
}
