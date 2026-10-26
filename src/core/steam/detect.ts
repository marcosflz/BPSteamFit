import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { AppError } from '@shared/errors'
import type { SteamAccount, SteamStatus } from '@shared/domain'
import {
  accountIdToSteamId64,
  normalizeSteamRoot,
  parseAccountId,
  steamId64ToAccountId,
  steamLoginUsersPath,
  steamShortcutsPath,
  steamUserDataDirectory,
  tryParseAccountId
} from './paths'
import {
  getTextVdfObject,
  getTextVdfString,
  parseTextVdf,
  type TextVdfObject
} from './text-vdf'

export interface SteamRegistrySnapshot {
  hklm32InstallPath?: string | null
  hklm64InstallPath?: string | null
  hkcuSteamPath?: string | null
  hkcuSteamExe?: string | null
}

export type PathExists = (path: string) => boolean | Promise<boolean>

export interface SteamRootDetectionOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Ruta inyectada; tiene prioridad absoluta. */
  steamRoot?: string
  /** Snapshot ya leído del registro. Evita tocar el registro real. */
  registry?: SteamRegistrySnapshot
  /** Lector alternativo del registro (para integración o pruebas). */
  readRegistry?: (query: RegistryQuery) => Promise<string | null>
  pathExists?: PathExists
  /** Desactiva por completo el registro de Windows. */
  disableRegistry?: boolean
}

export interface SteamRootDetection {
  installed: boolean
  steamRoot?: string
  steamExe?: string
  source?: string
  warnings: string[]
}

export interface RegistryQuery {
  hive: 'HKLM' | 'HKCU'
  key: string
  value: string
  view: '32' | '64'
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function expandWindowsEnvironment(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key && env[key] !== undefined ? env[key] : match
  })
}

/** Lee un valor REG_SZ/REG_EXPAND_SZ con reg.exe. No lanza si no existe. */
export async function readWindowsRegistryValue(query: RegistryQuery): Promise<string | null> {
  const keyPath = `${query.hive}\\${query.key}`
  const argumentsList = ['query', keyPath, '/v', query.value, `/reg:${query.view}`]
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'reg.exe',
      argumentsList,
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
      (error, output) => {
        if (error) {
          reject(error)
          return
        }
        resolve(output)
      }
    )
  }).catch((error: unknown) => {
    const code = (error as { code?: string | number }).code
    if (code === 1 || code === 'ENOENT') return ''
    throw error
  })
  if (!stdout) return null

  const wanted = query.value.toLowerCase()
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('HKEY_')) continue
    const match = trimmed.match(/^(.+?)\s{2,}(REG_[A-Z0-9_]+)\s{2,}(.*)$/)
    if (!match) continue
    const [, name = '', type = '', rawValue = ''] = match
    if (name.trim().toLowerCase() !== wanted) continue
    if (type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') return null
    return rawValue
  }
  return null
}

async function readDefaultRegistrySnapshot(): Promise<{
  snapshot: SteamRegistrySnapshot
  warnings: string[]
}> {
  const warnings: string[] = []
  const read = async (query: RegistryQuery): Promise<string | null> => {
    try {
      return await readWindowsRegistryValue(query)
    } catch (error) {
      warnings.push(
        `No se pudo consultar el registro de Windows (${query.key} ${query.value}): ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }
  }
  const [hklm32, hklm64, hkcu64, hkcu32, exe64, exe32] = await Promise.all([
    read({ hive: 'HKLM', key: 'SOFTWARE\\Valve\\Steam', value: 'InstallPath', view: '32' }),
    read({ hive: 'HKLM', key: 'SOFTWARE\\Valve\\Steam', value: 'InstallPath', view: '64' }),
    read({ hive: 'HKCU', key: 'SOFTWARE\\Valve\\Steam', value: 'SteamPath', view: '64' }),
    read({ hive: 'HKCU', key: 'SOFTWARE\\Valve\\Steam', value: 'SteamPath', view: '32' }),
    read({ hive: 'HKCU', key: 'SOFTWARE\\Valve\\Steam', value: 'SteamExe', view: '64' }),
    read({ hive: 'HKCU', key: 'SOFTWARE\\Valve\\Steam', value: 'SteamExe', view: '32' })
  ])
  return {
    snapshot: {
      hklm32InstallPath: hklm32,
      hklm64InstallPath: hklm64,
      hkcuSteamPath: hkcu64 ?? hkcu32,
      hkcuSteamExe: exe64 ?? exe32
    },
    warnings
  }
}

function collectCandidates(options: Required<Pick<SteamRootDetectionOptions, 'platform'>> & {
  env: NodeJS.ProcessEnv
  steamRoot?: string
  registry?: SteamRegistrySnapshot
  steamExe?: string
}): Array<{ path: string; source: string; steamExe?: string }> {
  const candidates: Array<{ path: string; source: string; steamExe?: string }> = []
  const push = (path: string | null | undefined, source: string, steamExe?: string): void => {
    if (!path || path.trim().length === 0) return
    candidates.push({ path: expandWindowsEnvironment(path, options.env), source, ...(steamExe ? { steamExe } : {}) })
  }

  push(options.steamRoot, 'inyectada')
  push(options.steamExe ? dirname(options.steamExe) : undefined, 'steam.exe inyectado', options.steamExe)
  push(options.env.STEAM_PATH, 'variable STEAM_PATH')
  push(options.env.STEAM_ROOT, 'variable STEAM_ROOT')
  push(options.env.STEAM_COMPAT_CLIENT_INSTALL_PATH, 'variable STEAM_COMPAT_CLIENT_INSTALL_PATH')

  const registry = options.registry
  if (registry) {
    if (registry.hkcuSteamExe) {
      push(dirname(registry.hkcuSteamExe), 'registro HKCU SteamExe', registry.hkcuSteamExe)
    }
    push(registry.hklm32InstallPath, 'registro HKLM InstallPath (32)')
    push(registry.hklm64InstallPath, 'registro HKLM InstallPath (64)')
    push(registry.hkcuSteamPath, 'registro HKCU SteamPath')
  }

  const home = homedir()
  if (options.platform === 'win32') {
    push(options.env['ProgramFiles(x86)'] ? join(options.env['ProgramFiles(x86)'], 'Steam') : undefined, 'Program Files (x86)')
    push(options.env.ProgramFiles ? join(options.env.ProgramFiles, 'Steam') : undefined, 'Program Files')
    push(options.env.LOCALAPPDATA ? join(options.env.LOCALAPPDATA, 'Steam') : undefined, 'LOCALAPPDATA')
    push(options.env.ProgramW6432 ? join(options.env.ProgramW6432, 'Steam') : undefined, 'ProgramW6432')
  } else if (options.platform === 'darwin') {
    push(join(home, 'Library', 'Application Support', 'Steam'), 'macOS')
  } else {
    push(join(home, '.local', 'share', 'Steam'), 'Linux')
    push(join(home, '.steam', 'steam'), 'Linux')
  }
  return candidates
}

/**
 * Detecta la instalación de Steam. Las rutas inyectadas y los snapshots del
 * registro tienen prioridad; en pruebas se puede pasar `disableRegistry: true`
 * para no ejecutar nunca reg.exe.
 */
export async function detectSteamRoot(
  options: SteamRootDetectionOptions = {}
): Promise<SteamRootDetection> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const warnings: string[] = []
  const exists: PathExists = options.pathExists ?? defaultPathExists

  let registry = options.registry
  let registryExe = registry?.hkcuSteamExe ?? undefined
  if (!registry && options.readRegistry && !options.disableRegistry) {
    const read = options.readRegistry
    const safeRead = async (query: RegistryQuery): Promise<string | null> => {
      try {
        return await read(query)
      } catch (error) {
        warnings.push(
          `El lector de registro inyectado falló (${query.key} ${query.value}): ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return null
      }
    }
    const [hklm32, hklm64, hkcu, exe] = await Promise.all([
      safeRead({ hive: 'HKLM', key: 'SOFTWARE\\Valve\\Steam', value: 'InstallPath', view: '32' }),
      safeRead({ hive: 'HKLM', key: 'SOFTWARE\\Valve\\Steam', value: 'InstallPath', view: '64' }),
      safeRead({ hive: 'HKCU', key: 'SOFTWARE\\Valve\\Steam', value: 'SteamPath', view: '64' }),
      safeRead({ hive: 'HKCU', key: 'SOFTWARE\\Valve\\Steam', value: 'SteamExe', view: '64' })
    ])
    registry = {
      hklm32InstallPath: hklm32,
      hklm64InstallPath: hklm64,
      hkcuSteamPath: hkcu,
      hkcuSteamExe: exe
    }
    registryExe = exe ?? undefined
  } else if (!registry && platform === 'win32' && !options.disableRegistry) {
    const result = await readDefaultRegistrySnapshot()
    registry = result.snapshot
    warnings.push(...result.warnings)
    registryExe = registry.hkcuSteamExe ?? undefined
  }

  const candidates = collectCandidates({
    platform,
    env,
    ...(options.steamRoot ? { steamRoot: options.steamRoot } : {}),
    ...(registry ? { registry } : {}),
    ...(registryExe ? { steamExe: registryExe } : {})
  })
  const seen = new Set<string>()

  for (const candidate of candidates) {
    let root: string
    let candidateExe = candidate.steamExe
    try {
      const looksLikeExe = basename(candidate.path).toLowerCase() === 'steam.exe'
      root = normalizeSteamRoot(looksLikeExe ? dirname(candidate.path) : candidate.path, platform)
      if (looksLikeExe) candidateExe = candidate.path
    } catch {
      continue
    }
    const key = platform === 'win32' ? root.toLowerCase() : root
    if (seen.has(key)) continue
    seen.add(key)

    const exePath = join(root, 'steam.exe')
    const userdataPath = steamUserDataDirectory(root)
    const steamappsPath = join(root, 'steamapps')
    const [hasExe, hasUserdata, hasSteamapps] = await Promise.all([
      exists(exePath),
      exists(userdataPath),
      exists(steamappsPath)
    ])
    if (!hasExe && !hasUserdata && !hasSteamapps) {
      warnings.push(`La ruta candidata de Steam no parece válida (${candidate.source}): ${root}`)
      continue
    }
    const resolvedExe =
      candidateExe && (await exists(candidateExe))
        ? candidateExe
        : hasExe
          ? exePath
          : undefined
    return {
      installed: true,
      steamRoot: root,
      ...(resolvedExe ? { steamExe: resolvedExe } : {}),
      source: candidate.source,
      warnings
    }
  }

  return {
    installed: false,
    warnings: [...warnings, 'No se encontró una instalación de Steam.']
  }
}

export interface LoginUser {
  steamId64: string
  accountId: string
  accountName?: string
  personaName?: string
  mostRecent: boolean
  timestamp?: number
}

export interface LoginUsersResult {
  users: LoginUser[]
  warnings: string[]
}

function parseBooleanText(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

export async function readSteamLoginUsers(
  steamRoot: string,
  options: { loginUsersPath?: string } = {}
): Promise<LoginUsersResult> {
  const path = options.loginUsersPath ?? steamLoginUsersPath(steamRoot)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { users: [], warnings: [] }
    return {
      users: [],
      warnings: [`No se pudo leer loginusers.vdf: ${error instanceof Error ? error.message : String(error)}`]
    }
  }
  const parsed = parseTextVdf(text)
  if (!parsed.ok) {
    return { users: [], warnings: [`loginusers.vdf no se pudo parsear: ${parsed.error}`] }
  }
  const usersObject = getTextVdfObject(parsed.root, 'users')
  if (!usersObject) {
    return { users: [], warnings: ['loginusers.vdf no contiene el objeto "users".'] }
  }
  const users: LoginUser[] = []
  const warnings = [...parsed.warnings]
  for (const [key, rawValue] of Object.entries(usersObject)) {
    if (!rawValue || typeof rawValue !== 'object') continue
    const accountId = steamId64ToAccountId(key)
    if (!accountId) {
      warnings.push(`loginusers.vdf contiene un id de usuario no reconocido: ${key}`)
      continue
    }
    const value = rawValue as TextVdfObject
    const timestampText = getTextVdfString(value, 'Timestamp')
    const timestamp = timestampText && /^\d+$/.test(timestampText)
      ? Number.parseInt(timestampText, 10)
      : undefined
    const accountName = getTextVdfString(value, 'AccountName')
    const personaName = getTextVdfString(value, 'PersonaName') ?? accountName
    users.push({
      steamId64: key,
      accountId,
      ...(accountName ? { accountName } : {}),
      ...(personaName ? { personaName } : {}),
      mostRecent: parseBooleanText(getTextVdfString(value, 'mostrecent')),
      ...(timestamp !== undefined ? { timestamp } : {})
    })
  }
  return { users, warnings }
}

export function pickActiveLoginUser(users: LoginUser[]): LoginUser | undefined {
  const flagged = users.filter((user) => user.mostRecent)
  const pool = flagged.length > 0 ? flagged : users
  return [...pool].sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))[0]
}

export interface SteamProfilesResult {
  accounts: SteamAccount[]
  warnings: string[]
  loginUsers: LoginUser[]
  activeAccountId?: string
}

export interface ListSteamProfilesOptions {
  selectedAccountId?: string
  loginUsersPath?: string
  /** Inyectable para pruebas; por defecto lee config/loginusers.vdf. */
  readLoginUsers?: (steamRoot: string) => Promise<LoginUsersResult>
}

export async function listSteamProfiles(
  steamRoot: string,
  options: ListSteamProfilesOptions = {}
): Promise<SteamProfilesResult> {
  const root = normalizeSteamRoot(steamRoot)
  const userdata = steamUserDataDirectory(root)
  let entries
  try {
    entries = await readdir(userdata, { withFileTypes: true })
  } catch (error) {
    throw new AppError('STEAM_PROFILE_NOT_FOUND', `No se pudo leer userdata de Steam: ${userdata}`, {
      details: { userdata, cause: error instanceof Error ? error.message : String(error) }
    })
  }

  const warnings: string[] = []
  const directoryAccountIds: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const accountId = tryParseAccountId(entry.name)
    if (!accountId) {
      if (/^7656\d{13}$/.test(entry.name)) {
        warnings.push(
          `Se ignoró ${entry.name} en userdata: parece un SteamID64; el directorio debe ser el accountId de 32 bits.`
        )
      } else {
        warnings.push(`Se ignoró el directorio no numérico de userdata: ${entry.name}`)
      }
      continue
    }
    directoryAccountIds.push(accountId)
  }
  directoryAccountIds.sort((left, right) => Number(left) - Number(right))

  const login = options.readLoginUsers
    ? await options.readLoginUsers(root)
    : await readSteamLoginUsers(root, options.loginUsersPath ? { loginUsersPath: options.loginUsersPath } : {})
  warnings.push(...login.warnings)

  const byAccount = new Map<string, LoginUser>()
  for (const user of login.users) {
    const existing = byAccount.get(user.accountId)
    if (!existing || (user.timestamp ?? 0) > (existing.timestamp ?? 0)) {
      byAccount.set(user.accountId, user)
    }
  }
  const active = pickActiveLoginUser(login.users)
  const activeAccountId = active?.accountId
  const requestedSelection = options.selectedAccountId
  let selectedId: string | undefined
  if (requestedSelection) {
    try {
      selectedId = parseAccountId(requestedSelection)
      if (!directoryAccountIds.includes(selectedId)) {
        warnings.push(`La cuenta seleccionada ${requestedSelection} no existe en userdata.`)
      }
    } catch {
      warnings.push(
        `La cuenta seleccionada no es un accountId de 32 bits válido: ${requestedSelection}`
      )
    }
  }

  const accounts: SteamAccount[] = directoryAccountIds.map((accountId) => {
    const user = byAccount.get(accountId)
    const isActive = accountId === activeAccountId
    return {
      accountId,
      steamId64: user?.steamId64 ?? accountIdToSteamId64(accountId),
      ...(user?.personaName ? { personaName: user.personaName } : {}),
      shortcutsPath: steamShortcutsPath(root, accountId),
      isActive,
      isSelected: selectedId ? selectedId === accountId : isActive
    }
  })

  return {
    accounts,
    warnings,
    loginUsers: login.users,
    ...(activeAccountId ? { activeAccountId } : {})
  }
}

export async function listSteamAccounts(
  steamRoot: string,
  options: ListSteamProfilesOptions = {}
): Promise<SteamAccount[]> {
  return (await listSteamProfiles(steamRoot, options)).accounts
}

export interface SteamProcessProbe {
  isRunning(): Promise<boolean>
}

export type ExecFileAsyncLike = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean; encoding?: 'utf8' }
) => Promise<{ stdout: string }>

function defaultExecFileAsync(
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean; encoding?: 'utf8' }
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout })
    })
  })
}

export function parseTasklistOutput(stdout: string): boolean {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => /^"?steam\.exe"?\s*,/i.test(line) || /^"?steam\.exe"?$/i.test(line))
}

/** Sonda por defecto. En tests se inyecta otra, nunca se ejecuta esta. */
export function createSteamProcessProbe(
  options: { platform?: NodeJS.Platform; execFile?: ExecFileAsyncLike } = {}
): SteamProcessProbe {
  const platform = options.platform ?? process.platform
  const exec = options.execFile ?? defaultExecFileAsync
  return {
    async isRunning(): Promise<boolean> {
      if (platform === 'win32') {
        const { stdout } = await exec(
          'tasklist',
          ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'],
          { timeout: 5000, windowsHide: true, encoding: 'utf8' }
        )
        return parseTasklistOutput(stdout)
      }
      const processName = platform === 'darwin' ? 'steam_osx' : 'steam'
      try {
        const { stdout } = await exec('pgrep', ['-x', processName], {
          timeout: 5000,
          encoding: 'utf8'
        })
        return stdout.trim().length > 0
      } catch (error) {
        if ((error as { code?: string | number }).code === 1) return false
        throw error
      }
    }
  }
}

export async function isSteamProcessRunning(
  probe: SteamProcessProbe = createSteamProcessProbe()
): Promise<boolean> {
  return probe.isRunning()
}

export interface DetectSteamStatusOptions extends SteamRootDetectionOptions {
  selectedAccountId?: string
  processProbe?: SteamProcessProbe
  /** Inyectable; evita consultar procesos reales en tests. */
  running?: boolean
  readLoginUsers?: (steamRoot: string) => Promise<LoginUsersResult>
}

/** Compone SteamStatus (contrato compartido) para la integración Electron. */
export async function detectSteamStatus(
  options: DetectSteamStatusOptions = {}
): Promise<SteamStatus> {
  const detection = await detectSteamRoot(options)
  if (!detection.installed || !detection.steamRoot) {
    return {
      installed: false,
      running: false,
      accounts: [],
      pendingChanges: [],
      ...(detection.warnings.length > 0 ? { warning: detection.warnings.join(' ') } : {})
    }
  }

  const warnings = [...detection.warnings]
  let profiles: SteamProfilesResult
  try {
    profiles = await listSteamProfiles(detection.steamRoot, {
      ...(options.selectedAccountId ? { selectedAccountId: options.selectedAccountId } : {}),
      ...(options.readLoginUsers ? { readLoginUsers: options.readLoginUsers } : {})
    })
  } catch (error) {
    profiles = { accounts: [], warnings: [], loginUsers: [] }
    warnings.push(error instanceof Error ? error.message : String(error))
  }
  warnings.push(...profiles.warnings)

  let running = options.running ?? false
  if (options.running === undefined) {
    try {
      running = await (options.processProbe ?? createSteamProcessProbe()).isRunning()
    } catch (error) {
      warnings.push(
        `No se pudo determinar si Steam está en ejecución: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  const selectedAccount = profiles.accounts.find((account) => account.isSelected)
  return {
    installed: true,
    steamPath: detection.steamRoot,
    running,
    accounts: profiles.accounts,
    ...(selectedAccount
      ? { selectedAccountId: selectedAccount.accountId }
      : profiles.activeAccountId
        ? { selectedAccountId: profiles.activeAccountId }
        : {}),
    pendingChanges: [],
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
  }
}

/** Comprueba que un archivo de userdata pertenece a una cuenta válida. */
export async function assertAccountDirectory(
  steamRoot: string,
  accountId: string
): Promise<string> {
  const normalized = tryParseAccountId(accountId)
  if (!normalized) {
    throw new AppError('STEAM_PROFILE_NOT_FOUND', `accountId no válido: ${accountId}`)
  }
  const directory = join(steamUserDataDirectory(steamRoot), normalized)
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) {
      throw new AppError('STEAM_PROFILE_NOT_FOUND', `La cuenta ${normalized} no es un directorio.`)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('STEAM_PROFILE_NOT_FOUND', `No existe la cuenta ${normalized} en userdata.`, {
      details: { directory, cause: error instanceof Error ? error.message : String(error) }
    })
  }
  return directory
}
