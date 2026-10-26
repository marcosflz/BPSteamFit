import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppError } from '@shared/errors'

/**
 * Envoltorio mínimo de SQLite síncrono (node:sqlite está incluido en Node 24 /
 * Electron 45). Las consultas son locales y cortas; la UI nunca espera a I/O
 * de red desde aquí. Las operaciones de archivos y procesos van por promesas.
 */
export class AppDatabase {
  private constructor(readonly db: DatabaseSync) {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    migrate(db)
  }

  static open(filePath: string): AppDatabase {
    try {
      if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true })
      const db = new DatabaseSync(filePath)
      return new AppDatabase(db)
    } catch (error) {
      throw new AppError('DATABASE_ERROR', 'No se pudo abrir la base de datos local.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string) {
    return this.db.prepare(sql)
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // El error original es más informativo.
      }
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        value_encrypted TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        edition TEXT,
        current_package_key TEXT,
        current_version TEXT,
        provider_ids_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT,
        identity_json TEXT NOT NULL DEFAULT '{"status":"none","candidates":[]}',
        artwork_json TEXT NOT NULL DEFAULT '{}',
        steam_json TEXT NOT NULL DEFAULT '{"enabled":true,"displayName":"","tags":[],"syncState":"none"}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS packages (
        key TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        version TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        imported_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 1,
        problem TEXT,
        entry_count INTEGER NOT NULL DEFAULT 0,
        payload_bytes INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        UNIQUE (game_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_packages_game ON packages(game_id);
      CREATE INDEX IF NOT EXISTS idx_packages_path ON packages(file_path);

      CREATE TABLE IF NOT EXISTS installs (
        game_id TEXT PRIMARY KEY,
        package_key TEXT NOT NULL,
        state TEXT NOT NULL,
        install_dir TEXT,
        log_path TEXT,
        pid INTEGER,
        active INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS install_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        package_key TEXT,
        state TEXT NOT NULL,
        at TEXT NOT NULL,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_install_events_game ON install_events(game_id, id);

      CREATE TABLE IF NOT EXISTS metadata_cache (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artwork (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_game_id TEXT,
        remote_url TEXT,
        original_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        bytes INTEGER,
        content_type TEXT,
        variants_json TEXT NOT NULL DEFAULT '{}',
        chosen INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artwork_game_kind ON artwork(game_id, kind);

      CREATE TABLE IF NOT EXISTS steam_shortcuts (
        game_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        shortcut_app_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        exe_path TEXT NOT NULL,
        start_dir TEXT NOT NULL,
        icon_path TEXT,
        launch_options TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        managed INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS steam_syncs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        backup_path TEXT,
        applied_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        steam_restarted INTEGER NOT NULL DEFAULT 0,
        worker_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_steam_syncs_requested ON steam_syncs(requested_at);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE artwork ADD COLUMN provider_asset_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artwork_provider_asset
        ON artwork(game_id, kind, provider, provider_asset_id);
    `
  },
  {
    version: 3,
    sql: `
      ALTER TABLE steam_shortcuts RENAME TO steam_shortcuts_legacy;
      CREATE TABLE steam_shortcuts (
        game_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        shortcut_app_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        exe_path TEXT NOT NULL,
        start_dir TEXT NOT NULL,
        icon_path TEXT,
        launch_options TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        managed INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, game_id),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      INSERT OR REPLACE INTO steam_shortcuts
        (game_id, account_id, shortcut_app_id, display_name, exe_path, start_dir, icon_path,
         launch_options, tags_json, managed, updated_at)
      SELECT game_id, account_id, shortcut_app_id, display_name, exe_path, start_dir, icon_path,
             launch_options, tags_json, managed, updated_at
      FROM steam_shortcuts_legacy;
      DROP TABLE steam_shortcuts_legacy;
      CREATE INDEX IF NOT EXISTS idx_steam_shortcuts_account ON steam_shortcuts(account_id, game_id);
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE artwork ADD COLUMN author TEXT;
      ALTER TABLE artwork ADD COLUMN attribution TEXT;
      ALTER TABLE artwork ADD COLUMN license TEXT;
    `
  }
]

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  let currentVersion = Number(row?.user_version ?? 0)
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
      currentVersion = migration.version
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Conserva el error original.
      }
      throw new AppError('DATABASE_ERROR', 'No se pudo migrar la base de datos local.', {
        cause: error instanceof Error ? error.message : String(error),
        details: { migration: migration.version }
      })
    }
  }
}
