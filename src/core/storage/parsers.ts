import type { GameMetadata, IdentityState, InstallSnapshot, SteamGameState } from '@shared/domain'
import type { Manifest } from '@shared/manifest'
import type {
  GameRow,
  InstallRow,
  PackageRow,
  ParsedGame,
  ParsedPackage,
  SteamShortcutRow,
  SteamSyncRow
} from './types'

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function parseGame(row: GameRow): ParsedGame {
  return {
    ...row,
    metadata: parseJson<GameMetadata | null>(row.metadata_json, null),
    identity: parseJson<IdentityState>(row.identity_json, {
      status: 'none',
      candidates: []
    }),
    artwork: parseJson<Record<string, unknown>>(row.artwork_json, {}),
    steam: parseJson<SteamGameState>(row.steam_json, {
      enabled: true,
      displayName: row.name,
      tags: [],
      syncState: 'none'
    }),
    providerIds: parseJson<Record<string, string>>(row.provider_ids_json, {})
  }
}

export function parsePackage(row: PackageRow): ParsedPackage {
  return {
    ...row,
    manifest: parseJson<Manifest>(row.manifest_json, {} as Manifest),
    warnings: parseJson<string[]>(row.warnings_json, [])
  }
}

export function parseInstall(row: InstallRow | null): InstallSnapshot | null {
  if (!row) return null
  const snapshot = parseJson<InstallSnapshot | null>(row.snapshot_json, null)
  if (!snapshot) return null
  return snapshot
}

export function parseSteamShortcut(row: SteamShortcutRow | null): {
  row: SteamShortcutRow
  tags: string[]
} | null {
  if (!row) return null
  return { row, tags: parseJson<string[]>(row.tags_json, []) }
}

export function parseSteamSync(row: SteamSyncRow | null): SteamSyncRow | null {
  return row
}

export { parseJson }

/** Claves internas de settings que no se exponen en la API de la UI. */
export const SECRET_SETTING_NAMES = ['steamgriddb_api_key'] as const
export type SecretSettingName = (typeof SECRET_SETTING_NAMES)[number]
