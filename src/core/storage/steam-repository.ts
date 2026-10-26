import type { SteamSyncResult } from '@shared/domain'
import path from 'node:path'
import { parseJson } from './parsers'
import type { AppDatabase } from './database'
import type { SteamShortcutRow, SteamSyncRow } from './types'
import type { SteamSyncState, SteamSyncJob } from '../steam/sync'
import type { ManagedShortcutRef } from '../steam/shortcuts'

export interface ManagedShortcutInput {
  gameId: string
  displayName: string
  exePath: string
  startDir: string
  iconPath?: string
  launchOptions: string
  tags: string[]
  appId: number
}

export interface SyncWorkerRecord {
  job: SteamSyncJob
  jobPath: string
  statePath: string
}

export class SteamRepository {
  constructor(private readonly database: AppDatabase) {}

  listManagedRows(accountId?: string): SteamShortcutRow[] {
    if (accountId) {
      return this.database
        .prepare('SELECT * FROM steam_shortcuts WHERE managed = 1 AND account_id = ? ORDER BY game_id')
        .all(accountId) as unknown as SteamShortcutRow[]
    }
    return this.database
      .prepare('SELECT * FROM steam_shortcuts WHERE managed = 1 ORDER BY game_id')
      .all() as unknown as SteamShortcutRow[]
  }

  listManagedRefs(accountId: string): ManagedShortcutRef[] {
    return this.listManagedRows(accountId).map((row) => ({
      gameId: row.game_id,
      appId: row.shortcut_app_id
    }))
  }

  getManagedRow(accountId: string, gameId: string): SteamShortcutRow | null {
    return (
      (this.database
        .prepare('SELECT * FROM steam_shortcuts WHERE account_id = ? AND game_id = ?')
        .get(accountId, gameId) as unknown as SteamShortcutRow | undefined) ?? null
    )
  }

  upsertManagedShortcut(
    accountId: string,
    input: ManagedShortcutInput
  ): void {
    this.database
      .prepare(
        `INSERT INTO steam_shortcuts
          (game_id, account_id, shortcut_app_id, display_name, exe_path, start_dir, icon_path,
           launch_options, tags_json, managed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(account_id, game_id) DO UPDATE SET
           shortcut_app_id = excluded.shortcut_app_id,
           display_name = excluded.display_name,
           exe_path = excluded.exe_path,
           start_dir = excluded.start_dir,
           icon_path = excluded.icon_path,
           launch_options = excluded.launch_options,
           tags_json = excluded.tags_json,
           managed = 1,
           updated_at = excluded.updated_at`
      )
      .run(
        input.gameId,
        accountId,
        input.appId,
        input.displayName,
        input.exePath,
        input.startDir,
        input.iconPath ?? null,
        input.launchOptions,
        JSON.stringify(input.tags),
        new Date().toISOString()
      )
  }

  createSyncRunning(id: string, worker: SyncWorkerRecord): void {
    this.database
      .prepare(
        `INSERT INTO steam_syncs
          (id, status, requested_at, started_at, applied_json, worker_json)
         VALUES (?, 'running', ?, ?, '[]', ?)`
      )
      .run(
        id,
        worker.job.requestedAt ?? new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify(worker)
      )
  }

  updateSync(
    id: string,
    patch: {
      status?: string
      startedAt?: string | null
      completedAt?: string | null
      backupPath?: string | null
      appliedGameIds?: string[]
      error?: unknown
      steamRestarted?: boolean
      workerJson?: unknown
    }
  ): void {
    const current = this.getSyncRow(id)
    if (!current) return
    const applied = patch.appliedGameIds
      ? JSON.stringify(patch.appliedGameIds)
      : current.applied_json
    const error =
      patch.error === undefined
        ? current.error_json
        : patch.error === null
          ? null
          : JSON.stringify(patch.error)
    const workerJson =
      patch.workerJson === undefined
        ? current.worker_json
        : JSON.stringify(patch.workerJson)
    this.database
      .prepare(
        `UPDATE steam_syncs SET
           status = ?, started_at = ?, completed_at = ?, backup_path = ?, applied_json = ?,
           error_json = ?, steam_restarted = ?, worker_json = ?
         WHERE id = ?`
      )
      .run(
        patch.status ?? current.status,
        patch.startedAt === undefined ? current.started_at : patch.startedAt,
        patch.completedAt === undefined ? current.completed_at : patch.completedAt,
        patch.backupPath === undefined ? current.backup_path : patch.backupPath,
        applied,
        error,
        patch.steamRestarted === undefined ? current.steam_restarted : patch.steamRestarted ? 1 : 0,
        workerJson,
        id
      )
  }

  getSyncRow(id: string): SteamSyncRow | null {
    return (
      (this.database.prepare('SELECT * FROM steam_syncs WHERE id = ?').get(id) as unknown as
        | SteamSyncRow
        | undefined) ?? null
    )
  }

  getLastSyncRow(): SteamSyncRow | null {
    return (
      (this.database
        .prepare('SELECT * FROM steam_syncs ORDER BY requested_at DESC LIMIT 1')
        .get() as unknown as SteamSyncRow | undefined) ?? null
    )
  }

  listRunningSyncRows(): SteamSyncRow[] {
    return this.database
      .prepare("SELECT * FROM steam_syncs WHERE status = 'running' ORDER BY requested_at DESC")
      .all() as unknown as SteamSyncRow[]
  }

  getWorkerRecord(row: SteamSyncRow): SyncWorkerRecord | null {
    return parseJson<SyncWorkerRecord | null>(row.worker_json, null)
  }

  toResult(row: SteamSyncRow): SteamSyncResult {
    const applied = parseJson<string[]>(row.applied_json, [])
    return {
      id: row.id,
      status: row.status as SteamSyncResult['status'],
      requestedAt: row.requested_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      appliedGameIds: applied,
      backupPath: row.backup_path ?? undefined,
      error: parseJson<SteamSyncResult['error']>(row.error_json, undefined),
      steamRestarted: row.steam_restarted === 1
    }
  }

  markGameSynced(
    gameId: string,
    appId: number,
    syncedAt: string,
    error?: SteamSyncResult['error']
  ): void {
    const game = this.database
      .prepare('SELECT steam_json FROM games WHERE id = ?')
      .get(gameId) as unknown as { steam_json: string } | undefined
    if (!game) return
    const steam = parseJson<Record<string, unknown>>(game.steam_json, {})
    steam.syncState = error ? 'failed' : 'synced'
    steam.managedShortcutAppId = appId
    if (!error) steam.lastSyncedAt = syncedAt
    this.database
      .prepare('UPDATE games SET steam_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(steam), new Date().toISOString(), gameId)
  }

  markGameSyncFailed(gameId: string, error?: SteamSyncResult['error']): void {
    const game = this.database
      .prepare('SELECT steam_json FROM games WHERE id = ?')
      .get(gameId) as unknown as { steam_json: string } | undefined
    if (!game) return
    const steam = parseJson<Record<string, unknown>>(game.steam_json, {})
    steam.syncState = 'failed'
    if (error) steam.lastSyncError = error.message
    this.database
      .prepare('UPDATE games SET steam_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(steam), new Date().toISOString(), gameId)
  }

  applyWorkerState(id: string, state: SteamSyncState): void {
    const row = this.getSyncRow(id)
    if (!row) return
    const completedAt = state.completedAt ?? new Date().toISOString()
    this.database.transaction(() => {
      this.updateSync(id, {
        status:
          state.status === 'completed'
            ? 'completed'
            : state.status === 'aborted'
              ? 'aborted'
              : 'failed',
        startedAt: state.startedAt,
        completedAt: state.status === 'running' ? null : completedAt,
        backupPath: state.backupPath ?? null,
        appliedGameIds: state.appliedGameIds,
        error: state.error ?? null,
        steamRestarted: state.steamRestarted,
        workerJson: state
      })
      if (state.status === 'completed') {
        const desiredByGame = new Map(state.job.desired.map((entry) => [entry.gameId, entry]))
        for (const [gameId, appId] of Object.entries(state.managedAppIds)) {
          const desired = desiredByGame.get(gameId)
          if (!desired) continue
          this.upsertManagedShortcut(state.job.accountId.toString(), {
            gameId,
            displayName: desired.appName,
            exePath: desired.exePath,
            startDir: desired.startDir ?? path.win32.dirname(desired.exePath),
            iconPath: desired.iconPath,
            launchOptions: desired.launchOptions ?? '',
            tags: desired.tags ?? [],
            appId
          })
          this.markGameSynced(gameId, appId, completedAt)
        }
        for (const gameId of state.appliedGameIds) {
          if (!(gameId in state.managedAppIds)) {
            const existing = this.getManagedRow(String(state.job.accountId), gameId)
            if (existing) this.markGameSynced(gameId, existing.shortcut_app_id, completedAt)
          }
        }
      } else if (state.status === 'failed') {
        for (const desired of state.job.desired) {
          this.markGameSyncFailed(desired.gameId, state.error)
        }
      }
    })
  }
}
