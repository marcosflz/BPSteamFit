import { join, dirname, normalize, resolve, win32 } from 'node:path'
import { AppError } from '@shared/errors'

export const ACCOUNT_ID_MAX = 0xffffffff
export const STEAM_ID64_BASE = 76561197960265728n

/** El directorio userdata usa el accountId de 32 bits, no el SteamID64. */
export function parseAccountId(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^\d{1,10}$/.test(text)) {
    throw new AppError('STEAM_PROFILE_NOT_FOUND', `accountId no válido: ${String(value)}`, {
      details: { value: String(value) }
    })
  }
  const parsed = Number.parseInt(text, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > ACCOUNT_ID_MAX) {
    throw new AppError('STEAM_PROFILE_NOT_FOUND', `accountId fuera del rango de 32 bits: ${text}`, {
      details: { value: text }
    })
  }
  return String(parsed)
}

export function tryParseAccountId(value: string): string | null {
  try {
    return parseAccountId(value)
  } catch {
    return null
  }
}

export function accountIdToSteamId64(accountId: string | number): string {
  const normalized = parseAccountId(accountId)
  return (STEAM_ID64_BASE + BigInt(normalized)).toString()
}

export function steamId64ToAccountId(steamId64: string | bigint): string | null {
  let id: bigint
  try {
    id = typeof steamId64 === 'bigint' ? steamId64 : BigInt(steamId64)
  } catch {
    return null
  }
  if (id < STEAM_ID64_BASE + 1n || id > STEAM_ID64_BASE + BigInt(ACCOUNT_ID_MAX)) return null
  return (id - STEAM_ID64_BASE).toString()
}

export function normalizeSteamRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new AppError('STEAM_NOT_FOUND', 'La ruta de Steam está vacía.')
  }
  const trimmed = root.trim()
  if (platform === 'win32') {
    // Steam suele escribir rutas con / en el registro; se normalizan a \.
    return win32.normalize(trimmed.replace(/\//g, '\\')).replace(/[\\]+$/, '')
  }
  return normalize(trimmed).replace(/\/+$/, '')
}

export function steamConfigDirectory(steamRoot: string): string {
  return join(steamRoot, 'config')
}

export function steamUserDataDirectory(steamRoot: string): string {
  return join(steamRoot, 'userdata')
}

export function steamAccountDirectory(steamRoot: string, accountId: string | number): string {
  return join(steamRoot, 'userdata', parseAccountId(accountId))
}

export function steamShortcutsPath(steamRoot: string, accountId: string | number): string {
  return join(steamAccountDirectory(steamRoot, accountId), 'config', 'shortcuts.vdf')
}

export function steamGridDirectory(steamRoot: string, accountId: string | number): string {
  return join(steamAccountDirectory(steamRoot, accountId), 'config', 'grid')
}

export function steamLoginUsersPath(steamRoot: string): string {
  return join(steamConfigDirectory(steamRoot), 'loginusers.vdf')
}

export function steamExecutablePath(steamRoot: string): string {
  return join(steamRoot, 'steam.exe')
}

export function steamRootFromExecutable(steamExe: string): string {
  return dirname(resolve(steamExe))
}
