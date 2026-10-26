import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isPathInside } from '@shared/safe-path'

export interface AppPaths {
  userData: string
  databaseFile: string
  logs: string
  temp: string
  artwork: string
  steamBackups: string
  steamSync: string
  defaultPackages: string
  defaultGames: string
}

export function createAppPaths(userData: string): AppPaths {
  const resolved = path.resolve(userData)
  const home = os.homedir()
  return {
    userData: resolved,
    databaseFile: path.join(resolved, 'bpsteamfit.sqlite3'),
    logs: path.join(resolved, 'logs'),
    temp: path.join(resolved, 'temp'),
    artwork: path.join(resolved, 'artwork'),
    steamBackups: path.join(resolved, 'steam-backups'),
    steamSync: path.join(resolved, 'steam-sync'),
    defaultPackages: path.join(home, 'BPSteamFit', 'Packages'),
    defaultGames: path.join(home, 'BPSteamFit', 'Games')
  }
}

export async function ensureBaseDirectories(paths: AppPaths): Promise<void> {
  for (const directory of [
    paths.userData,
    paths.logs,
    paths.temp,
    paths.artwork,
    paths.steamBackups,
    paths.steamSync
  ]) {
    await mkdir(directory, { recursive: true })
  }
}

export function createSessionLogPath(paths: AppPaths, tag = 'app'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(paths.logs, `${tag}-${stamp}.log`)
}

export function createInstallLogPath(paths: AppPaths, gameId: string): string {
  const safeId = gameId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(paths.logs, `install-${safeId}-${stamp}.log`)
}

/**
 * Limpia solo temporales de extracción gestionados por la app que llevan más
 * de 24 h. Nunca toca un setup que pudiera seguir en ejecución tras un cierre
 * inesperado reciente.
 */
export async function cleanupStaleInstallTemps(
  paths: AppPaths,
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<number> {
  let removed = 0
  let entries
  try {
    entries = await readdir(paths.temp, { withFileTypes: true })
  } catch {
    return 0
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('bpsfit-install-')) continue
    const target = path.join(paths.temp, entry.name)
    if (!isPathInside(paths.temp, target)) continue
    try {
      const info = await stat(target)
      if (now - info.mtimeMs < maxAgeMs) continue
      await rm(target, { recursive: true, force: true })
      removed += 1
    } catch {
      // Otro proceso puede estar usándolo; se reintentará en el próximo arranque.
    }
  }
  return removed
}
