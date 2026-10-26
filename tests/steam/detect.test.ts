import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountIdToSteamId64,
  detectSteamRoot,
  detectSteamStatus,
  listSteamProfiles,
  parseTasklistOutput,
  readSteamLoginUsers,
  steamId64ToAccountId
} from '@core/steam'
import {
  ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  STEAM_ID64,
  cleanupTempDirectories,
  createTempSteam
} from './helpers'

afterEach(cleanupTempDirectories)

describe('Detección de Steam y perfiles', () => {
  it('convierte accountId de 32 bits y SteamID64 sin confundirlos', () => {
    expect(accountIdToSteamId64(ACCOUNT_ID)).toBe(STEAM_ID64)
    expect(steamId64ToAccountId(STEAM_ID64)).toBe(ACCOUNT_ID)
    expect(steamId64ToAccountId('12345')).toBeNull()
    expect(steamId64ToAccountId('76561198000000000')).not.toBeNull()
  })

  it('detecta una ruta inyectada sin tocar el registro', async () => {
    const temp = await createTempSteam()
    const readRegistry = vi.fn(async () => {
      throw new Error('no debería leer el registro')
    })
    const result = await detectSteamRoot({
      steamRoot: temp.root,
      platform: 'win32',
      env: {},
      readRegistry,
      disableRegistry: true
    })
    expect(result.installed).toBe(true)
    expect(result.steamRoot).toBe(temp.root)
    expect(result.source).toBe('inyectada')
    expect(readRegistry).not.toHaveBeenCalled()
  })

  it('usa un snapshot de registro inyectado y variables de entorno', async () => {
    const temp = await createTempSteam()
    const byRegistry = await detectSteamRoot({
      platform: 'win32',
      env: {},
      registry: { hkcuSteamPath: temp.root.replace(/\\/g, '/') },
      disableRegistry: true
    })
    expect(byRegistry.installed).toBe(true)
    expect(byRegistry.steamRoot).toBe(temp.root)
    expect(byRegistry.source).toBe('registro HKCU SteamPath')

    const byEnv = await detectSteamRoot({
      platform: 'win32',
      env: { STEAM_PATH: temp.root },
      disableRegistry: true
    })
    expect(byEnv.installed).toBe(true)
    expect(byEnv.source).toBe('variable STEAM_PATH')
  })

  it('devuelve installed=false sin candidatos válidos', async () => {
    const result = await detectSteamRoot({
      platform: 'win32',
      env: {},
      steamRoot: 'C:\\No\\Existe\\Steam',
      disableRegistry: true
    })
    expect(result.installed).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('enumera cuentas, asocia persona y marca la más reciente', async () => {
    const temp = await createTempSteam({ accountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID] })
    await mkdir(join(temp.userdata, '76561198000000000'), { recursive: true })
    await mkdir(join(temp.userdata, 'no-numerico'), { recursive: true })

    const profiles = await listSteamProfiles(temp.root)
    expect(profiles.accounts).toHaveLength(2)
    const first = profiles.accounts.find((account) => account.accountId === ACCOUNT_ID)
    expect(first).toMatchObject({
      accountId: ACCOUNT_ID,
      steamId64: STEAM_ID64,
      personaName: 'Marco',
      isActive: true,
      isSelected: true
    })
    expect(first?.shortcutsPath).toBe(temp.shortcutsPath)
    const second = profiles.accounts.find((account) => account.accountId === OTHER_ACCOUNT_ID)
    expect(second).toMatchObject({
      personaName: 'Other Player',
      isActive: false,
      isSelected: false
    })
    expect(profiles.warnings.some((warning) => warning.includes('SteamID64'))).toBe(true)
    expect(profiles.warnings.some((warning) => warning.includes('no numérico'))).toBe(true)
  })

  it('tolera un BOM al inicio de loginusers.vdf', async () => {
    const temp = await createTempSteam({ accountIds: [ACCOUNT_ID] })
    const original = await readFile(temp.loginUsersPath, 'utf8')
    await writeFile(temp.loginUsersPath, `\uFEFF${original}`, 'utf8')
    const login = await readSteamLoginUsers(temp.root)
    expect(login.users).toHaveLength(2)
    expect(login.users.find((user) => user.accountId === ACCOUNT_ID)?.personaName).toBe('Marco')
  })

  it('tolera loginusers corrupto y sigue enumerando cuentas', async () => {
    const temp = await createTempSteam({ accountIds: [ACCOUNT_ID] })
    await writeFile(temp.loginUsersPath, '"users" { "76561197960278073" { "PersonaName" "sin cerrar"', 'utf8')
    const login = await readSteamLoginUsers(temp.root)
    expect(login.users).toHaveLength(0)
    expect(login.warnings.length).toBeGreaterThan(0)
    const profiles = await listSteamProfiles(temp.root)
    expect(profiles.accounts).toHaveLength(1)
    expect(profiles.accounts[0]?.personaName).toBeUndefined()
    expect(profiles.accounts[0]?.steamId64).toBe(STEAM_ID64)
  })

  it('compone SteamStatus con una sonda inyectada', async () => {
    const temp = await createTempSteam({ accountIds: [ACCOUNT_ID] })
    const status = await detectSteamStatus({
      steamRoot: temp.root,
      platform: 'win32',
      env: {},
      disableRegistry: true,
      running: true
    })
    expect(status.installed).toBe(true)
    expect(status.running).toBe(true)
    expect(status.steamPath).toBe(temp.root)
    expect(status.accounts).toHaveLength(1)
    expect(status.selectedAccountId).toBe(ACCOUNT_ID)
    expect(status.pendingChanges).toEqual([])
  })

  it('interpreta tasklist en CSV y no confunde steamwebhelper', () => {
    expect(parseTasklistOutput('"steam.exe","1234","Console","1","10.000 K"\r\n')).toBe(true)
    expect(parseTasklistOutput('"steamwebhelper.exe","1234","Console","1","10.000 K"\r\n')).toBe(false)
    expect(parseTasklistOutput('INFO: No tasks are running which match the specified criteria.\r\n')).toBe(false)
  })

  it('no ejecuta tasklist real cuando se inyecta execFile', async () => {
    const { createSteamProcessProbe } = await import('@core/steam')
    const execFile = vi.fn(async () => ({ stdout: '"steam.exe","99","Console","1","1 K"\n' }))
    const probe = createSteamProcessProbe({ platform: 'win32', execFile })
    await expect(probe.isRunning()).resolves.toBe(true)
    expect(execFile).toHaveBeenCalledWith(
      'tasklist',
      ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'],
      expect.objectContaining({ timeout: 5000 })
    )
  })
})
