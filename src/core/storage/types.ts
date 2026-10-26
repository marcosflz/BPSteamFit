import type {
  AppSettings,
  GameMetadata,
  IdentityState,
  SteamGameState
} from '@shared/domain'
import type { Manifest } from '@shared/manifest'
import path from 'node:path'

export interface PackageRow {
  key: string
  game_id: string
  version: string
  file_path: string
  file_name: string
  file_size: number
  sha256: string
  manifest_json: string
  warnings_json: string
  imported_at: string
  last_seen_at: string
  available: number
  problem: string | null
  entry_count: number
  payload_bytes: number
  file_mtime_ms: number
}

export interface GameRow {
  id: string
  name: string
  edition: string | null
  current_package_key: string | null
  current_version: string | null
  provider_ids_json: string
  metadata_json: string | null
  identity_json: string
  artwork_json: string
  steam_json: string
  created_at: string
  updated_at: string
}

export interface InstallRow {
  game_id: string
  package_key: string
  state: string
  install_dir: string | null
  log_path: string | null
  pid: number | null
  active: number
  snapshot_json: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

export interface GameAggregate {
  game: GameRow
  currentPackage: PackageRow | null
  packages: PackageRow[]
  install: InstallRow | null
}

export interface ArtworkRow {
  id: string
  game_id: string
  kind: string
  provider: string
  provider_game_id: string | null
  provider_asset_id: string | null
  remote_url: string | null
  original_path: string
  width: number | null
  height: number | null
  bytes: number | null
  content_type: string | null
  variants_json: string
  chosen: number
  source: string
  created_at: string
  updated_at: string
  author: string | null
  attribution: string | null
  license: string | null
}

export interface SteamShortcutRow {
  game_id: string
  account_id: string
  shortcut_app_id: number
  display_name: string
  exe_path: string
  start_dir: string
  icon_path: string | null
  launch_options: string
  tags_json: string
  managed: number
  updated_at: string
}

export interface SteamSyncRow {
  id: string
  status: string
  requested_at: string
  started_at: string | null
  completed_at: string | null
  backup_path: string | null
  applied_json: string
  error_json: string | null
  steam_restarted: number
  worker_json: string | null
}

export interface ParsedGame extends GameRow {
  metadata: GameMetadata | null
  identity: IdentityState
  artwork: Record<string, unknown>
  steam: SteamGameState
  providerIds: Record<string, string>
}

export interface ParsedPackage extends PackageRow {
  manifest: Manifest
  warnings: string[]
}

export function defaultSettings(homeDirectory: string): AppSettings {
  return {
    packageFolders: [path.join(homeDirectory, 'BPSteamFit', 'Packages')],
    installationRoot: path.join(homeDirectory, 'BPSteamFit', 'Games'),
    metadataProvider: 'mock',
    referToMetadataInSpanish: true,
    onboardingCompleted: false
  }
}
