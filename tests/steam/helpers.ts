import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const ACCOUNT_ID = '12345'
export const OTHER_ACCOUNT_ID = '67890'
export const STEAM_ID64 = '76561197960278073'
export const KODI_APPID = 2443196458
export const FOREIGN_APPID = 0xf0000001

export const REPO_ROOT = process.cwd()
export const FIXTURES = resolve(REPO_ROOT, 'fixtures', 'steam')

const tempDirectories = new Set<string>()

export async function makeTempDirectory(prefix = 'bpsf-steam-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.add(directory)
  return directory
}

export async function cleanupTempDirectories(): Promise<void> {
  const directories = [...tempDirectories]
  tempDirectories.clear()
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true }))
  )
}

export interface TempSteam {
  root: string
  accountId: string
  otherAccountId: string
  userdata: string
  configDir: string
  accountConfigDir: string
  shortcutsPath: string
  gridDir: string
  steamExe: string
  backupDir: string
  statePath: string
  loginUsersPath: string
}

export async function createTempSteam(options: {
  withShortcuts?: boolean
  withLoginUsers?: boolean
  accountIds?: string[]
} = {}): Promise<TempSteam> {
  const root = await makeTempDirectory()
  const accountIds = options.accountIds ?? [ACCOUNT_ID]
  await mkdir(join(root, 'steamapps'), { recursive: true })
  await mkdir(join(root, 'config'), { recursive: true })
  for (const accountId of accountIds) {
    const accountConfigDir = join(root, 'userdata', accountId, 'config')
    await mkdir(join(accountConfigDir, 'grid'), { recursive: true })
    if (options.withShortcuts ?? true) {
      await copyFile(join(FIXTURES, 'shortcuts.sample.vdf'), join(accountConfigDir, 'shortcuts.vdf'))
    }
  }
  const accountConfigDir = join(root, 'userdata', ACCOUNT_ID, 'config')
  if (options.withLoginUsers ?? true) {
    await copyFile(join(FIXTURES, 'loginusers.vdf'), join(root, 'config', 'loginusers.vdf'))
  }
  return {
    root,
    accountId: ACCOUNT_ID,
    otherAccountId: OTHER_ACCOUNT_ID,
    userdata: join(root, 'userdata'),
    configDir: join(root, 'config'),
    accountConfigDir,
    shortcutsPath: join(accountConfigDir, 'shortcuts.vdf'),
    gridDir: join(accountConfigDir, 'grid'),
    steamExe: join(root, 'steam.exe'),
    backupDir: join(root, 'backups'),
    statePath: join(root, 'state.json'),
    loginUsersPath: join(root, 'config', 'loginusers.vdf')
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
