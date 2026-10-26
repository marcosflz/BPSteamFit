import type { GameMetadata, IdentityState, SteamGameState } from '@shared/domain'
import type { Manifest } from '@shared/manifest'
import { compareVersions } from '@shared/manifest'
import type { InspectedPackage } from '../package/package-service'
import type { AppDatabase } from './database'
import { parseGame, parseJson } from './parsers'
import type { GameAggregate, GameRow, InstallRow, PackageRow, SteamShortcutRow } from './types'

type SqlValue = string | number | null
type RegisterStatus = 'created' | 'version_added' | 'duplicate' | 'version_conflict'

export interface RegisterPackageOptions {
  relocateExisting?: boolean
}

export interface RegisterPackageResult {
  status: RegisterStatus
  gameId: string
  packageKey: string
  existingSha256?: string
}

export interface RelocatePackageInput {
  key: string
  filePath: string
  fileName: string
  fileSize: number
  mtimeMs: number
}

function packageKey(gameId: string, version: string): string {
  return `${gameId}@${version}`
}

function steamDefaults(manifest: Manifest, previous?: SteamGameState): SteamGameState {
  return {
    enabled: manifest.steam.enabled,
    displayName: manifest.steam.displayName ?? manifest.name,
    tags: [...manifest.steam.tags],
    syncState: previous?.syncState ?? 'none',
    managedShortcutAppId: previous?.managedShortcutAppId,
    lastSyncedAt: previous?.lastSyncedAt
  }
}

export class CatalogRepository {
  constructor(private readonly database: AppDatabase) {}

  private all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.database.prepare(sql).all(...params) as unknown as T[]
  }

  private get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.database.prepare(sql).get(...params) as unknown as T | undefined
  }

  private run(sql: string, ...params: SqlValue[]): void {
    this.database.prepare(sql).run(...params)
  }

  getGameRow(gameId: string): GameRow | null {
    return this.get<GameRow>('SELECT * FROM games WHERE id = ?', gameId) ?? null
  }

  getPackageRow(key: string): PackageRow | null {
    return this.get<PackageRow>('SELECT * FROM packages WHERE key = ?', key) ?? null
  }

  findPackageByVersion(gameId: string, version: string): PackageRow | null {
    return (
      this.get<PackageRow>('SELECT * FROM packages WHERE game_id = ? AND version = ?', gameId, version) ??
      null
    )
  }

  listPackagesForGame(gameId: string): PackageRow[] {
    return this.all<PackageRow>(
      'SELECT * FROM packages WHERE game_id = ? ORDER BY imported_at DESC',
      gameId
    )
  }

  listAllPackageRows(): PackageRow[] {
    return this.all<PackageRow>('SELECT * FROM packages ORDER BY game_id, imported_at DESC')
  }

  listGames(): GameRow[] {
    return this.all<GameRow>('SELECT * FROM games ORDER BY name COLLATE NOCASE, id')
  }

  getInstallRow(gameId: string): InstallRow | null {
    return this.get<InstallRow>('SELECT * FROM installs WHERE game_id = ?', gameId) ?? null
  }

  getAggregate(gameId: string): GameAggregate | null {
    const game = this.getGameRow(gameId)
    if (!game) return null
    const packages = this.listPackagesForGame(gameId)
    const currentPackage =
      packages.find((row) => row.key === game.current_package_key) ??
      packages.sort((a, b) => compareVersions(b.version, a.version))[0] ??
      null
    return {
      game,
      currentPackage,
      packages,
      install: this.getInstallRow(gameId)
    }
  }

  listAggregates(): GameAggregate[] {
    return this.listGames()
      .map((game) => this.getAggregate(game.id))
      .filter((entry): entry is GameAggregate => entry !== null)
  }

  registerPackage(
    inspected: InspectedPackage,
    options: RegisterPackageOptions = {}
  ): RegisterPackageResult {
    const manifest = inspected.manifest
    const key = packageKey(manifest.id, manifest.version)
    const now = new Date().toISOString()

    return this.database.transaction(() => {
      const existing = this.findPackageByVersion(manifest.id, manifest.version)
      if (existing) {
        if (existing.sha256 !== inspected.sha256) {
          return {
            status: 'version_conflict' as const,
            gameId: manifest.id,
            packageKey: existing.key,
            existingSha256: existing.sha256
          }
        }
        if (options.relocateExisting) {
          this.run(
            `UPDATE packages
             SET file_path = ?, file_name = ?, file_size = ?, file_mtime_ms = ?, available = 1, problem = NULL,
                 last_seen_at = ?, entry_count = ?, payload_bytes = ?
             WHERE key = ?`,
            inspected.filePath,
            inspected.fileName,
            inspected.size,
            inspected.mtimeMs,
            now,
            inspected.entryCount,
            inspected.payloadBytes,
            existing.key
          )
        } else {
          this.run(
            `UPDATE packages
             SET available = 1, problem = NULL, last_seen_at = ?, file_size = ?,
                 file_mtime_ms = ?, entry_count = ?, payload_bytes = ?
             WHERE key = ?`,
            now,
            inspected.size,
            inspected.mtimeMs,
            inspected.entryCount,
            inspected.payloadBytes,
            existing.key
          )
        }
        this.refreshGameCurrentPackage(existing.game_id)
        return {
          status: 'duplicate' as const,
          gameId: existing.game_id,
          packageKey: existing.key,
          existingSha256: existing.sha256
        }
      }

      let game = this.getGameRow(manifest.id)
      let status: RegisterStatus = 'version_added'
      if (!game) {
        status = 'created'
        const initialSteam = steamDefaults(manifest)
        const providerIds = JSON.stringify(manifest.metadata?.providerIds ?? {})
        const identity: IdentityState = {
          status: 'none',
          candidates: [],
          updatedAt: now
        }
        this.run(
          `INSERT INTO games
            (id, name, edition, current_package_key, current_version, provider_ids_json,
             metadata_json, identity_json, artwork_json, steam_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?, ?)`,
          manifest.id,
          manifest.name,
          manifest.metadata?.edition ?? null,
          key,
          manifest.version,
          providerIds,
          JSON.stringify(identity),
          JSON.stringify(initialSteam),
          now,
          now
        )
      } else {
        const parsed = parseGame(game)
        const providerIds = {
          ...parsed.providerIds,
          ...(manifest.metadata?.providerIds ?? {})
        }
        const nextSteam = steamDefaults(manifest, parsed.steam)
        const isNewer =
          !game.current_version || compareVersions(manifest.version, game.current_version) >= 0
        this.run(
          `UPDATE games SET
             name = ?, edition = ?, provider_ids_json = ?, steam_json = ?, updated_at = ?,
             current_package_key = CASE WHEN ? THEN ? ELSE current_package_key END,
             current_version = CASE WHEN ? THEN ? ELSE current_version END
           WHERE id = ?`,
          isNewer ? manifest.name : game.name,
          isNewer ? (manifest.metadata?.edition ?? null) : game.edition,
          JSON.stringify(providerIds),
          JSON.stringify(nextSteam),
          now,
          isNewer ? 1 : 0,
          key,
          isNewer ? 1 : 0,
          manifest.version,
          manifest.id
        )
      }

      this.run(
        `INSERT INTO packages
          (key, game_id, version, file_path, file_name, file_size, sha256, manifest_json,
           warnings_json, imported_at, last_seen_at, available, problem, entry_count, payload_bytes, file_mtime_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
        key,
        manifest.id,
        manifest.version,
        inspected.filePath,
        inspected.fileName,
        inspected.size,
        inspected.sha256,
        JSON.stringify(manifest),
        JSON.stringify(inspected.warnings),
        now,
        now,
        inspected.entryCount,
        inspected.payloadBytes,
        inspected.mtimeMs
      )

      return { status, gameId: manifest.id, packageKey: key }
    })
  }

  markPackageUnavailable(key: string, problem: string): void {
    const row = this.getPackageRow(key)
    if (!row) return
    this.run(
      'UPDATE packages SET available = 0, problem = ?, last_seen_at = ? WHERE key = ?',
      problem,
      new Date().toISOString(),
      key
    )
    this.refreshGameCurrentPackage(row.game_id)
  }

  markPackageAvailable(key: string): void {
    const row = this.getPackageRow(key)
    if (!row) return
    this.run('UPDATE packages SET available = 1, problem = NULL WHERE key = ?', key)
    this.refreshGameCurrentPackage(row.game_id)
  }

  touchPackage(key: string): void {
    this.run(
      'UPDATE packages SET available = 1, problem = NULL, last_seen_at = ? WHERE key = ?',
      new Date().toISOString(),
      key
    )
  }

  relocatePackage(input: RelocatePackageInput): void {
    this.run(
      'UPDATE packages SET file_path = ?, file_name = ?, file_size = ?, file_mtime_ms = ?, available = 1, problem = NULL, last_seen_at = ? WHERE key = ?',
      input.filePath,
      input.fileName,
      input.fileSize,
      input.mtimeMs,
      new Date().toISOString(),
      input.key
    )
  }

  /**
   * Marca como ausentes los paquetes de las carpetas escaneadas que no se han
   * vuelto a ver en esta pasada. Se basa en claves vistas, no en relojes, para
   * evitar carreras entre escaneos rápidos.
   */
  markMissingFromScan(roots: string[], seenPackageKeys: Set<string>): string[] {
    const normalizedRoots = roots.map((root) =>
      root.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
    )
    const affected = new Set<string>()
    for (const row of this.listAllPackageRows()) {
      if (!row.available || seenPackageKeys.has(row.key)) continue
      const normalizedPath = row.file_path.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
      const belongsToRoot = normalizedRoots.some(
        (root) => normalizedPath === root || normalizedPath.startsWith(`${root}\\`)
      )
      if (!belongsToRoot) continue
      this.run(
        'UPDATE packages SET available = 0, problem = ? WHERE key = ?',
        'El archivo del paquete ya no está en la carpeta configurada.',
        row.key
      )
      affected.add(row.game_id)
    }
    for (const gameId of affected) this.refreshGameCurrentPackage(gameId)
    return [...affected]
  }

  refreshGameCurrentPackage(gameId: string): PackageRow | null {
    const packages = this.listPackagesForGame(gameId)
    if (packages.length === 0) return null
    const available = packages.filter((row) => row.available === 1)
    const candidates = (available.length > 0 ? available : packages).sort((a, b) =>
      compareVersions(b.version, a.version)
    )
    const chosen = candidates[0] ?? null
    const game = this.getGameRow(gameId)
    if (chosen && game) {
      const manifest = parseJson<Manifest>(chosen.manifest_json, {} as Manifest)
      const parsed = parseGame(game)
      const nextSteam = manifest.steam
        ? steamDefaults(manifest, parsed.steam)
        : parsed.steam
      this.run(
        `UPDATE games SET current_package_key = ?, current_version = ?, name = ?, edition = ?,
           steam_json = ?, updated_at = ? WHERE id = ?`,
        chosen.key,
        chosen.version,
        manifest.name ?? game.name,
        manifest.metadata?.edition ?? null,
        JSON.stringify(nextSteam),
        new Date().toISOString(),
        gameId
      )
    }
    return chosen
  }

  setMetadataAndIdentity(
    gameId: string,
    metadata: GameMetadata | null,
    identity: IdentityState
  ): void {
    this.run(
      'UPDATE games SET metadata_json = ?, identity_json = ?, updated_at = ? WHERE id = ?',
      metadata ? JSON.stringify(metadata) : null,
      JSON.stringify(identity),
      new Date().toISOString(),
      gameId
    )
  }

  setIdentity(gameId: string, identity: IdentityState): void {
    this.run(
      'UPDATE games SET identity_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(identity),
      new Date().toISOString(),
      gameId
    )
  }

  setArtwork(gameId: string, artwork: Record<string, unknown>): void {
    this.run(
      'UPDATE games SET artwork_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(artwork),
      new Date().toISOString(),
      gameId
    )
  }

  setSteamGameState(gameId: string, steam: SteamGameState): void {
    this.run(
      'UPDATE games SET steam_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(steam),
      new Date().toISOString(),
      gameId
    )
  }

  setProviderIds(gameId: string, providerIds: Record<string, string>): void {
    this.run(
      'UPDATE games SET provider_ids_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(providerIds),
      new Date().toISOString(),
      gameId
    )
  }

  findManagedShortcut(gameId: string): SteamShortcutRow | null {
    return (
      this.get<SteamShortcutRow>('SELECT * FROM steam_shortcuts WHERE game_id = ?', gameId) ?? null
    )
  }

  listActiveInstallRows(): InstallRow[] {
    return this.all<InstallRow>('SELECT * FROM installs WHERE active = 1')
  }

  hasActiveInstall(): boolean {
    return Boolean(this.get<{ count: number }>('SELECT COUNT(*) AS count FROM installs WHERE active = 1')?.count)
  }
}
