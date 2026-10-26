import type { ArtworkKind, ArtworkSet, ArtworkView } from '@shared/domain'
import { ARTWORK_KINDS } from '@shared/domain'
import { buildMediaUrl } from '@shared/media'
import type { AppDatabase } from './database'
import { parseJson } from './parsers'
import type { ArtworkRow } from './types'

export interface ArtworkVariantPaths {
  preview?: string
  original?: string
}

export interface UpsertArtworkInput {
  id: string
  gameId: string
  kind: ArtworkKind
  provider: string
  providerGameId?: string
  providerAssetId?: string
  remoteUrl?: string
  originalKey: string
  variantKey: string
  width?: number
  height?: number
  bytes?: number
  contentType?: string
  source: 'provider' | 'manual'
  author?: string
  attribution?: string
  license?: string
}

function rowPreviewKey(row: ArtworkRow): string | null {
  const variants = parseJson<ArtworkVariantPaths>(row.variants_json, {})
  return variants.preview ?? null
}

export function artworkRowToView(row: ArtworkRow): ArtworkView {
  return {
    id: row.id,
    kind: row.kind as ArtworkKind,
    provider: row.provider,
    providerGameId: row.provider_game_id ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    source: row.source === 'manual' ? 'manual' : 'provider',
    chosen: row.chosen === 1,
    previewUrl: buildMediaUrl(row.id, 'preview'),
    createdAt: row.created_at,
    author: row.author ?? undefined,
    attribution: row.attribution ?? undefined,
    license: row.license ?? undefined
  }
}

export class ArtworkRepository {
  constructor(private readonly database: AppDatabase) {}

  private rowsForGame(gameId: string, kind?: ArtworkKind): ArtworkRow[] {
    const sql = kind
      ? 'SELECT * FROM artwork WHERE game_id = ? AND kind = ? ORDER BY chosen DESC, created_at DESC'
      : 'SELECT * FROM artwork WHERE game_id = ? ORDER BY created_at DESC'
    const params = kind ? [gameId, kind] : [gameId]
    return this.database.prepare(sql).all(...params) as unknown as ArtworkRow[]
  }

  getRow(id: string): ArtworkRow | null {
    return (
      (this.database.prepare('SELECT * FROM artwork WHERE id = ?').get(id) as unknown as
        | ArtworkRow
        | undefined) ?? null
    )
  }

  getPreviewKey(id: string): string | null {
    const row = this.getRow(id)
    return row ? rowPreviewKey(row) : null
  }

  getOriginalKey(id: string): string | null {
    const row = this.getRow(id)
    return row?.original_path ?? null
  }

  listViews(gameId: string, kind?: ArtworkKind): ArtworkView[] {
    return this.rowsForGame(gameId, kind).map(artworkRowToView)
  }

  getChosenViews(gameId: string): ArtworkSet {
    const set: ArtworkSet = {}
    for (const row of this.rowsForGame(gameId)) {
      if (row.chosen === 1) set[row.kind as ArtworkKind] = artworkRowToView(row)
    }
    return set
  }

  getChosenRow(gameId: string, kind: ArtworkKind): ArtworkRow | null {
    return (
      (this.database
        .prepare('SELECT * FROM artwork WHERE game_id = ? AND kind = ? AND chosen = 1 LIMIT 1')
        .get(gameId, kind) as unknown as ArtworkRow | undefined) ?? null
    )
  }

  findByProviderAsset(
    gameId: string,
    kind: ArtworkKind,
    provider: string,
    providerAssetId: string
  ): ArtworkRow | null {
    return (
      (this.database
        .prepare(
          'SELECT * FROM artwork WHERE game_id = ? AND kind = ? AND provider = ? AND provider_asset_id = ? LIMIT 1'
        )
        .get(gameId, kind, provider, providerAssetId) as unknown as ArtworkRow | undefined) ?? null
    )
  }

  upsert(input: UpsertArtworkInput): ArtworkView {
    const now = new Date().toISOString()
    const variants: ArtworkVariantPaths = {
      preview: input.variantKey,
      original: input.originalKey
    }
    this.database
      .prepare(
        `INSERT INTO artwork
          (id, game_id, kind, provider, provider_game_id, provider_asset_id, remote_url,
           original_path, width, height, bytes, content_type, variants_json, chosen, source,
           author, attribution, license, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_game_id = excluded.provider_game_id,
           provider_asset_id = excluded.provider_asset_id,
           remote_url = excluded.remote_url,
           original_path = excluded.original_path,
           width = excluded.width,
           height = excluded.height,
           bytes = excluded.bytes,
           content_type = excluded.content_type,
           variants_json = excluded.variants_json,
           author = excluded.author,
           attribution = excluded.attribution,
           license = excluded.license,
           source = CASE WHEN artwork.chosen = 1 AND artwork.source = 'manual' THEN 'manual' ELSE excluded.source END,
           updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.gameId,
        input.kind,
        input.provider,
        input.providerGameId ?? null,
        input.providerAssetId ?? null,
        input.remoteUrl ?? null,
        input.originalKey,
        input.width ?? null,
        input.height ?? null,
        input.bytes ?? null,
        input.contentType ?? null,
        JSON.stringify(variants),
        input.source,
        input.author ?? null,
        input.attribution ?? null,
        input.license ?? null,
        now,
        now
      )
    const row = this.getRow(input.id)
    if (!row) {
      throw new Error('No se pudo guardar el artwork en la base de datos.')
    }
    return artworkRowToView(row)
  }

  choose(gameId: string, kind: ArtworkKind, assetId: string, source: 'provider' | 'manual'): ArtworkView {
    const row = this.getRow(assetId)
    if (!row || row.game_id !== gameId || row.kind !== kind) {
      throw new Error('El artwork seleccionado no pertenece a este juego y tipo.')
    }
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE artwork SET chosen = 0 WHERE game_id = ? AND kind = ?')
        .run(gameId, kind)
      this.database
        .prepare('UPDATE artwork SET chosen = 1, source = ?, updated_at = ? WHERE id = ?')
        .run(source, new Date().toISOString(), assetId)
      this.syncGameArtwork(gameId)
    })
    return artworkRowToView(this.getRow(assetId) as ArtworkRow)
  }

  /** No pisa una selección manual; si no hay o era automática, elige la nueva. */
  chooseAutomatic(gameId: string, kind: ArtworkKind, assetId: string): ArtworkView | null {
    const current = this.getChosenRow(gameId, kind)
    if (current?.source === 'manual') return artworkRowToView(current)
    const row = this.getRow(assetId)
    if (!row || row.game_id !== gameId || row.kind !== kind) return null
    return this.choose(gameId, kind, assetId, 'provider')
  }

  clearChoice(gameId: string, kind: ArtworkKind): void {
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE artwork SET chosen = 0 WHERE game_id = ? AND kind = ?')
        .run(gameId, kind)
      this.syncGameArtwork(gameId)
    })
  }

  removeProviderArtwork(gameId: string): void {
    this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM artwork WHERE game_id = ? AND source = 'provider'")
        .run(gameId)
      this.syncGameArtwork(gameId)
    })
  }

  syncGameArtwork(gameId: string): void {
    const rows = this.database
      .prepare('SELECT * FROM artwork WHERE game_id = ? AND chosen = 1')
      .all(gameId) as unknown as ArtworkRow[]
    const set: ArtworkSet = {}
    for (const row of rows) {
      if ((ARTWORK_KINDS as readonly string[]).includes(row.kind)) {
        set[row.kind as ArtworkKind] = artworkRowToView(row)
      }
    }
    this.database
      .prepare('UPDATE games SET artwork_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(set), new Date().toISOString(), gameId)
  }
}
