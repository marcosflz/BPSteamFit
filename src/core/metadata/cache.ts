import { createHash } from 'node:crypto'
import type { MetadataCache, MetadataCacheRecord } from './types'

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

/**
 * Clave estable y legible para SQLite. Incluye el proveedor y una huella de
 * los parámetros para no reutilizar datos entre proveedores distintos.
 */
export function buildCacheKey(provider: string, namespace: string, parts: unknown): string {
  const digest = createHash('sha256').update(stableStringify(parts)).digest('hex')
  return `metadata:v1:${provider}:${namespace}:${digest}`
}

export function isCacheExpired(record: MetadataCacheRecord, now: Date = new Date()): boolean {
  const expiresAt = Date.parse(record.expiresAt)
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt <= now.getTime()
}

export function makeCacheRecord(
  key: string,
  provider: string,
  value: unknown,
  options: { now?: Date; ttlMs: number }
): MetadataCacheRecord {
  const now = options.now ?? new Date()
  const ttl = Math.max(0, Math.trunc(options.ttlMs))
  return {
    key,
    provider,
    value,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString()
  }
}

/** Implementación en memoria útil para tests y para la primera ejecución. */
export class MemoryMetadataCache implements MetadataCache {
  private readonly entries = new Map<string, MetadataCacheRecord>()

  async get(key: string): Promise<MetadataCacheRecord | null> {
    const record = this.entries.get(key)
    return record ? { ...record } : null
  }

  async set(record: MetadataCacheRecord): Promise<void> {
    this.entries.set(record.key, { ...record })
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }
}
