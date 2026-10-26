import type { InstallSnapshot } from '@shared/domain'
import type { AppDatabase } from './database'
import { parseInstall, parseJson } from './parsers'
import type { InstallRow } from './types'

const ACTIVE_STATES = new Set(['validating', 'extracting', 'installing', 'verifying'])
const TRANSIENT_STATES = new Set(['validating', 'extracting', 'installing', 'verifying'])

export function isActiveInstallState(state: string): boolean {
  return ACTIVE_STATES.has(state)
}

export interface InterruptedInstall {
  gameId: string
  previous: InstallSnapshot
  pid?: number
}

export class InstallRepository {
  constructor(private readonly database: AppDatabase) {}

  saveSnapshot(gameId: string, packageKey: string, snapshot: InstallSnapshot): void {
    const now = new Date().toISOString()
    const active = isActiveInstallState(snapshot.state) ? 1 : 0
    const previous = this.getRow(gameId)
    const previousState = previous?.state
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO installs
            (game_id, package_key, state, install_dir, log_path, pid, active, snapshot_json,
             started_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(game_id) DO UPDATE SET
             package_key = excluded.package_key,
             state = excluded.state,
             install_dir = excluded.install_dir,
             log_path = excluded.log_path,
             pid = excluded.pid,
             active = excluded.active,
             snapshot_json = excluded.snapshot_json,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             updated_at = excluded.updated_at`
        )
        .run(
          gameId,
          packageKey,
          snapshot.state,
          snapshot.installDir ?? null,
          snapshot.logPath ?? null,
          snapshot.pid ?? null,
          active,
          JSON.stringify(snapshot),
          snapshot.startedAt ?? null,
          snapshot.finishedAt ?? null,
          now
        )
      if (previousState !== snapshot.state) {
        this.database
          .prepare(
            'INSERT INTO install_events (game_id, package_key, state, at, detail_json) VALUES (?, ?, ?, ?, ?)'
          )
          .run(
            gameId,
            packageKey,
            snapshot.state,
            now,
            JSON.stringify({
              progress: snapshot.progress,
              exitCode: snapshot.exitCode,
              error: snapshot.error
            })
          )
      }
    })
  }

  getRow(gameId: string): InstallRow | null {
    return (
      (this.database.prepare('SELECT * FROM installs WHERE game_id = ?').get(gameId) as unknown as
        | InstallRow
        | undefined) ?? null
    )
  }

  getSnapshot(gameId: string): InstallSnapshot | null {
    return parseInstall(this.getRow(gameId))
  }

  getActiveCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM installs WHERE active = 1')
      .get() as unknown as { count: number } | undefined
    return Number(row?.count ?? 0)
  }

  /**
   * Detecta instalaciones que quedaron en estado transitorio al cerrarse la
   * app. No afirma que el setup siga vivo; el servicio puede comprobar el PID.
   */
  markInterruptedOnStartup(): InterruptedInstall[] {
    const rows = this.database
      .prepare('SELECT * FROM installs WHERE active = 1')
      .all() as unknown as InstallRow[]
    const results: InterruptedInstall[] = []
    const now = new Date().toISOString()
    for (const row of rows) {
      const previous = parseInstall(row) ?? {
        state: 'interrupted',
        startedAt: row.started_at ?? undefined,
        updatedAt: now
      }
      const next: InstallSnapshot = {
        ...previous,
        state: 'interrupted',
        updatedAt: now,
        error: {
          code: 'INSTALL_INTERRUPTED',
          message:
            'La aplicación se cerró mientras la instalación estaba en curso. Comprueba el estado del instalador y usa "Comprobar instalación" si terminó.'
        }
      }
      this.database.transaction(() => {
        this.database
          .prepare(
            'UPDATE installs SET state = ?, active = 0, snapshot_json = ?, updated_at = ? WHERE game_id = ?'
          )
          .run('interrupted', JSON.stringify(next), now, row.game_id)
        this.database
          .prepare(
            'INSERT INTO install_events (game_id, package_key, state, at, detail_json) VALUES (?, ?, ?, ?, ?)'
          )
          .run(
            row.game_id,
            row.package_key,
            'interrupted',
            now,
            JSON.stringify({ detectedOnStartup: true, previousState: row.state })
          )
      })
      results.push({
        gameId: row.game_id,
        previous,
        pid: row.pid ?? undefined
      })
    }
    return results
  }

  listEvents(gameId: string, limit = 50): Array<{
    state: string
    at: string
    detail: unknown
  }> {
    const rows = this.database
      .prepare(
        'SELECT state, at, detail_json FROM install_events WHERE game_id = ? ORDER BY id DESC LIMIT ?'
      )
      .all(gameId, limit) as unknown as Array<{
      state: string
      at: string
      detail_json: string | null
    }>
    return rows.map((row) => ({
      state: row.state,
      at: row.at,
      detail: parseJson<unknown>(row.detail_json, null)
    }))
  }

  /** Solo se usa en pruebas y recuperación explícita. */
  isTransient(state: string): boolean {
    return TRANSIENT_STATES.has(state)
  }
}
