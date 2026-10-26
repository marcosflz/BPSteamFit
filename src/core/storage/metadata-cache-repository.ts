import { AppError } from '@shared/errors'
import type { MetadataCache, MetadataCacheRecord } from '../metadata/types'
import type { AppDatabase } from './database'

/**
 * Caché de metadatos en SQLite. Conserva registros expirados para que el
 * servicio pueda servir datos guardados si el proveedor falla o no hay red.
 */
export class SqliteMetadataCache implements MetadataCache {
  constructor(private readonly database: AppDatabase) {}

  async get(key: string): Promise<MetadataCacheRecord | null> {
    try {
      const row = this.database
        .prepare(
          'SELECT cache_key, provider, payload_json, fetched_at, expires_at FROM metadata_cache WHERE cache_key = ?'
        )
        .get(key) as unknown as
        | {
            cache_key: string
            provider: string
            payload_json: string
            fetched_at: string
            expires_at: string | null
          }
        | undefined
      if (!row) return null
      return {
        key: row.cache_key,
        provider: row.provider,
        value: JSON.parse(row.payload_json) as unknown,
        createdAt: row.fetched_at,
        expiresAt: row.expires_at ?? row.fetched_at
      }
    } catch (error) {
      throw new AppError('DATABASE_ERROR', 'No se pudo leer la caché de metadatos.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async set(record: MetadataCacheRecord): Promise<void> {
    try {
      this.database
        .prepare(
          `INSERT INTO metadata_cache (cache_key, provider, kind, payload_json, fetched_at, expires_at)
           VALUES (?, ?, 'metadata', ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             provider = excluded.provider,
             payload_json = excluded.payload_json,
             fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at`
        )
        .run(
          record.key,
          record.provider,
          JSON.stringify(record.value),
          record.createdAt,
          record.expiresAt
        )
    } catch (error) {
      throw new AppError('DATABASE_ERROR', 'No se pudo guardar la caché de metadatos.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async delete(key: string): Promise<void> {
    this.database.prepare('DELETE FROM metadata_cache WHERE cache_key = ?').run(key)
  }
}
