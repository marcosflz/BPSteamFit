import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyShortcutPlan,
  computeShortcutAppId,
  createEmptyShortcutsRoot,
  inspectShortcuts,
  planShortcutChanges,
  readShortcutsFile,
  removeManagedShortcuts,
  serializeBinaryVdf,
  serializeShortcutsVdf,
  type ManagedShortcutRef,
  type ShortcutDesired
} from '@core/steam'
import {
  FOREIGN_APPID,
  KODI_APPID,
  cleanupTempDirectories,
  createTempSteam
} from './helpers'

afterEach(cleanupTempDirectories)

const KODI_REF: ManagedShortcutRef = { gameId: 'kodi', appId: KODI_APPID }

function desired(overrides: Partial<ShortcutDesired> = {}): ShortcutDesired {
  return {
    gameId: 'kodi',
    appName: 'Kodi',
    exePath: 'C:\\Games\\Kodi\\kodi.exe',
    startDir: 'C:\\Games\\Kodi',
    launchOptions: '--fullscreen',
    iconPath: 'C:\\Icons\\kodi.ico',
    tags: ['Salon'],
    ...overrides
  }
}

function findRecord(root: ReturnType<typeof createEmptyShortcutsRoot>, appId: number) {
  return inspectShortcuts(root).records.find((record) => record.appId === appId)
}

describe('Gestión de shortcuts gestionados', () => {
  it('actualiza solo la entrada gestionada y preserva la ajena byte a byte', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const originalInspection = inspectShortcuts(snapshot.root)
    const foreignBefore = originalInspection.records.find((record) => record.appId === FOREIGN_APPID)
    expect(foreignBefore).toBeDefined()

    const plan = planShortcutChanges(snapshot.root, [desired()], [KODI_REF])
    const change = plan.changes[0]
    expect(change?.action).toBe('update')
    expect(change?.appId).toBe(KODI_APPID)
    expect(change?.entryKey).toBe('0')
    expect(change?.appIdSource).toBe('managed')
    expect(change?.normalized.tags).toEqual(['Media', 'Couch', 'Salon'])

    const applied = applyShortcutPlan(snapshot.root, plan)
    const output = serializeShortcutsVdf(applied.root)
    const reparsed = inspectShortcuts(
      (await readShortcutsFile(temp.shortcutsPath)).root
    )
    // El archivo en disco no se tocó; se inspecciona el root aplicado.
    expect(reparsed.records).toHaveLength(2)

    const kodi = findRecord(applied.root, KODI_APPID)
    expect(kodi).toMatchObject({
      appName: 'Kodi',
      exeField: '"C:\\Games\\Kodi\\kodi.exe"',
      startDirField: '"C:\\Games\\Kodi"',
      launchOptions: '--fullscreen',
      iconField: '"C:\\Icons\\kodi.ico"',
      tags: ['Media', 'Couch', 'Salon']
    })
    const foreignAfter = findRecord(applied.root, FOREIGN_APPID)
    expect(foreignAfter?.entry).toEqual(foreignBefore?.entry)
    if (foreignBefore) {
      const foreignBytes = serializeBinaryVdf(foreignBefore.entry)
      expect(output.indexOf(foreignBytes)).toBeGreaterThanOrEqual(0)
    }
    const unknown = inspectShortcuts(applied.root).records
      .find((record) => record.appId === KODI_APPID)
      ?.entry.entries.find((entry) => entry.key === 'UnknownField')
    expect(unknown?.value).toMatchObject({ kind: 'string', value: 'keep-me' })
  })

  it('es idempotente: un segundo plan no reescribe ni duplica', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const plan = planShortcutChanges(snapshot.root, [desired()], [KODI_REF])
    const applied = applyShortcutPlan(snapshot.root, plan)
    const secondPlan = planShortcutChanges(applied.root, [desired()], [KODI_REF])
    expect(secondPlan.changes[0]?.action).toBe('unchanged')
    const secondApplied = applyShortcutPlan(applied.root, secondPlan)
    expect(secondApplied.applied).toHaveLength(0)
    expect(serializeShortcutsVdf(secondApplied.root).equals(serializeShortcutsVdf(applied.root))).toBe(true)
    expect(inspectShortcuts(secondApplied.root).records).toHaveLength(2)
  })

  it('añade un acceso nuevo con AppID heredado, comillas y campos canónicos', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const hades = desired({
      gameId: 'hades',
      appName: 'Hades',
      exePath: 'C:\\Games\\Hades\\Hades.exe',
      startDir: 'C:\\Games\\Hades',
      launchOptions: '--skip-launcher',
      iconPath: 'C:\\Icons\\hades.ico',
      tags: ['Roguelike']
    })
    const plan = planShortcutChanges(snapshot.root, [hades], [])
    const change = plan.changes[0]
    const expectedAppId = computeShortcutAppId(hades.exePath, hades.appName)
    expect(change?.action).toBe('add')
    expect(change?.appId).toBe(expectedAppId)
    expect(change?.entryKey).toBe('2')
    expect(change?.appIdSource).toBe('legacy-crc')

    const applied = applyShortcutPlan(snapshot.root, plan)
    const record = findRecord(applied.root, expectedAppId)
    expect(record).toMatchObject({
      appName: 'Hades',
      exeField: '"C:\\Games\\Hades\\Hades.exe"',
      startDirField: '"C:\\Games\\Hades"',
      launchOptions: '--skip-launcher',
      iconField: '"C:\\Icons\\hades.ico"',
      tags: ['Roguelike']
    })
    expect(record?.signedAppId).toBe(expectedAppId | 0)
    const next = planShortcutChanges(
      applied.root,
      [hades],
      [{ gameId: 'hades', appId: expectedAppId }]
    )
    expect(next.changes[0]?.action).toBe('unchanged')
    expect(inspectShortcuts(applied.root).records).toHaveLength(3)
  })

  it('detecta colisiones por nombre y por Exe sin modificar la entrada ajena', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const before = await readFile(temp.shortcutsPath)

    const byName = planShortcutChanges(
      snapshot.root,
      [
        desired({
          gameId: 'collision-name',
          appName: 'Foreign App',
          exePath: 'C:\\Otro\\juego.exe'
        })
      ],
      []
    )
    expect(byName.changes[0]?.action).toBe('conflict')
    expect(byName.collisions.some((collision) => collision.kind === 'name')).toBe(true)
    expect(() => applyShortcutPlan(snapshot.root, byName)).toThrowError(/conflictos/)

    const byExe = planShortcutChanges(
      snapshot.root,
      [
        desired({
          gameId: 'collision-exe',
          appName: 'Otro Nombre',
          exePath: 'C:\\Games\\Foreign\\foreign.exe'
        })
      ],
      []
    )
    expect(byExe.changes[0]?.action).toBe('conflict')
    expect(byExe.collisions.some((collision) => collision.kind === 'exe')).toBe(true)
    expect(await readFile(temp.shortcutsPath)).toEqual(before)
  })

  it('renombra manteniendo el AppID persistido y sin crear un duplicado', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const plan = planShortcutChanges(
      snapshot.root,
      [
        desired({
          appName: 'Kodi Renombrado',
          exePath: 'C:\\Kodi\\kodi.exe',
          appId: 999_999_999
        })
      ],
      [KODI_REF]
    )
    const change = plan.changes[0]
    expect(change?.action).toBe('update')
    expect(change?.appId).toBe(KODI_APPID)
    expect(change?.appIdSource).toBe('managed')
    const applied = applyShortcutPlan(snapshot.root, plan)
    expect(inspectShortcuts(applied.root).records).toHaveLength(2)
    expect(findRecord(applied.root, KODI_APPID)?.appName).toBe('Kodi Renombrado')
    // El artwork sigue usando el mismo AppID; no hay renombrado de archivos.
    expect(findRecord(applied.root, KODI_APPID)?.appId).toBe(KODI_APPID)
  })

  it('recrea una entrada gestionada ausente con su AppID persistido', () => {
    const plan = planShortcutChanges(createEmptyShortcutsRoot(), [desired()], [KODI_REF])
    expect(plan.changes[0]?.action).toBe('add')
    expect(plan.changes[0]?.appId).toBe(KODI_APPID)
    const applied = applyShortcutPlan(createEmptyShortcutsRoot(), plan)
    expect(findRecord(applied.root, KODI_APPID)?.appName).toBe('Kodi')
  })

  it('permite reemplazar etiquetas o conservar las del usuario', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const merged = planShortcutChanges(snapshot.root, [desired({ tags: ['Salon'] })], [KODI_REF])
    expect(merged.changes[0]?.normalized.tags).toEqual(['Media', 'Couch', 'Salon'])

    const replaced = planShortcutChanges(
      snapshot.root,
      [desired({ tags: ['Solo'] })],
      [KODI_REF],
      { tagMode: 'replace' }
    )
    expect(replaced.changes[0]?.normalized.tags).toEqual(['Solo'])
    const applied = applyShortcutPlan(snapshot.root, replaced)
    expect(findRecord(applied.root, KODI_APPID)?.tags).toEqual(['Solo'])
  })

  it('no adopta una entrada ajena al actualizar un nombre que colisiona', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const plan = planShortcutChanges(
      snapshot.root,
      [desired({ appName: 'Foreign App', exePath: 'C:\\Kodi\\kodi.exe' })],
      [KODI_REF]
    )
    expect(plan.changes[0]?.action).toBe('conflict')
    expect(() => applyShortcutPlan(snapshot.root, plan)).toThrowError(/conflictos/)
    expect(findRecord(snapshot.root, FOREIGN_APPID)?.appName).toBe('Foreign App')
  })

  it('retira solo el shortcut gestionado indicado por appid', async () => {
    const temp = await createTempSteam()
    const snapshot = await readShortcutsFile(temp.shortcutsPath)
    const result = removeManagedShortcuts(snapshot.root, [KODI_REF], {
      expectedAppName: 'Kodi'
    })
    expect(result.removed).toEqual([{ gameId: 'kodi', appId: KODI_APPID, entryKey: '0' }])
    const records = inspectShortcuts(result.root).records
    expect(records).toHaveLength(1)
    expect(records[0]?.appId).toBe(FOREIGN_APPID)
    const refused = removeManagedShortcuts(snapshot.root, [KODI_REF], {
      expectedAppName: 'Otro nombre'
    })
    expect(refused.removed).toHaveLength(0)
    expect(refused.skipped[0]?.reason).toBe('nombre-distinto')
    expect(inspectShortcuts(refused.root).records).toHaveLength(2)
  })

  it('no permite que un appid explícito pise el de otra referencia gestionada', () => {
    const plan = planShortcutChanges(
      createEmptyShortcutsRoot(),
      [
        {
          gameId: 'nuevo',
          appName: 'Nuevo',
          exePath: 'C:\\Games\\Nuevo\\nuevo.exe',
          appId: KODI_APPID
        }
      ],
      [KODI_REF]
    )
    expect(plan.changes[0]?.action).toBe('conflict')
    expect(plan.collisions[0]?.kind).toBe('appId')
  })

  it('rechaza rutas relativas y nombres vacíos', () => {
    expect(() =>
      planShortcutChanges(createEmptyShortcutsRoot(), [desired({ exePath: 'relativo\\juego.exe' })], [])
    ).toThrowError(/absoluta/)
    expect(() =>
      planShortcutChanges(createEmptyShortcutsRoot(), [desired({ appName: '  ' })], [])
    ).toThrowError(/vacío/)
  })

  it('falla al leer un shortcuts.vdf corrupto sin borrar el archivo', async () => {
    const temp = await createTempSteam()
    await writeFile(temp.shortcutsPath, Buffer.from('esto no es vdf'))
    await expect(readShortcutsFile(temp.shortcutsPath)).rejects.toMatchObject({
      code: 'STEAM_VDF_INVALID'
    })
    expect((await readFile(temp.shortcutsPath)).toString('utf8')).toBe('esto no es vdf')
  })
})
