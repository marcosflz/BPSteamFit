import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { AppError } from '@shared/errors'
import {
  allocateShortcutAppId,
  computeShortcutAppIdFromFields,
  quoteSteamPath,
  toSignedAppId,
  toUnsignedAppId,
  unquoteSteamPath
} from './appid'
import {
  createEmptyShortcutsRoot,
  createVdfEntry,
  createVdfInt32,
  createVdfObject,
  createVdfString,
  findVdfEntryCaseInsensitive,
  getShortcutsContainer,
  parseShortcutsVdf,
  serializeShortcutsVdf,
  type VdfEntry,
  type VdfObject,
  type VdfValue
} from './binary-vdf'
import { parseAccountId, steamShortcutsPath } from './paths'

export const SHORTCUT_FILE_MAX_BYTES = 16 * 1024 * 1024
export const SHORTCUT_NAME_MAX = 200
export const SHORTCUT_TAG_MAX = 64
export const SHORTCUT_TAGS_MAX = 20
export const SHORTCUT_LAUNCH_OPTIONS_MAX = 4096

export interface ShortcutsFileSnapshot {
  path: string
  exists: boolean
  root: VdfObject
  buffer?: Buffer
  sha256?: string
  size?: number
  mtimeMs?: number
}

export interface ReadShortcutsOptions {
  allowMissing?: boolean
  maxBytes?: number
}

/**
 * Lee shortcuts.vdf sin "arreglarlo" en silencio. Si el archivo no existe y
 * allowMissing es true (por defecto), devuelve un documento vacío; si está
 * corrupto lanza STEAM_VDF_INVALID y no se debe sobrescribir.
 */
export async function readShortcutsFile(
  path: string,
  options: ReadShortcutsOptions = {}
): Promise<ShortcutsFileSnapshot> {
  const maxBytes = options.maxBytes ?? SHORTCUT_FILE_MAX_BYTES
  let buffer: Buffer
  let info
  try {
    info = await stat(path)
    if (info.size > maxBytes) {
      throw new AppError('STEAM_VDF_INVALID', `shortcuts.vdf supera ${maxBytes} bytes.`, {
        details: { path, size: info.size }
      })
    }
    buffer = await readFile(path)
  } catch (error) {
    if (error instanceof AppError) throw error
    if ((error as { code?: string }).code === 'ENOENT' && (options.allowMissing ?? true)) {
      return { path, exists: false, root: createEmptyShortcutsRoot() }
    }
    throw new AppError('STEAM_VDF_INVALID', `No se pudo leer shortcuts.vdf: ${path}`, {
      details: { path, cause: error instanceof Error ? error.message : String(error) }
    })
  }
  if (buffer.length > maxBytes) {
    throw new AppError('STEAM_VDF_INVALID', `shortcuts.vdf supera ${maxBytes} bytes.`, {
      details: { path, size: buffer.length }
    })
  }
  const root = parseShortcutsVdf(buffer)
  return {
    path,
    exists: true,
    root,
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
    mtimeMs: info.mtimeMs
  }
}

export async function readAccountShortcuts(
  steamRoot: string,
  accountId: string | number,
  options: ReadShortcutsOptions = {}
): Promise<ShortcutsFileSnapshot> {
  return readShortcutsFile(steamShortcutsPath(steamRoot, parseAccountId(accountId)), options)
}

export interface ShortcutIssue {
  code: string
  key: string
  message: string
}

export interface ShortcutRecord {
  containerKey: string
  entry: VdfObject
  /** AppID sin signo; ausente si la entrada está malformada. */
  appId?: number
  signedAppId?: number
  appName: string
  exeField: string
  startDirField: string
  launchOptions: string
  iconField: string
  tags: string[]
  malformed: boolean
}

export interface ShortcutInspection {
  records: ShortcutRecord[]
  issues: ShortcutIssue[]
  /** Contenedor "shortcuts" original; se usa para elegir claves sin mutarlo. */
  container: VdfObject
}

function getStringField(object: VdfObject, key: string): string {
  const entry = findVdfEntryCaseInsensitive(object, key)
  return entry?.value.kind === 'string' ? entry.value.value : ''
}

function getAppIdField(object: VdfObject): {
  appId?: number
  signedAppId?: number
  issue?: string
} {
  const entry = findVdfEntryCaseInsensitive(object, 'appid')
  if (!entry) return { issue: 'La entrada no tiene appid.' }
  try {
    if (entry.value.kind === 'int32') {
      const signed = entry.value.value
      return { signedAppId: signed, appId: toUnsignedAppId(signed) }
    }
    if (entry.value.kind === 'uint64') {
      if (entry.value.value > 0xffffffffn) {
        return { issue: 'El appid uint64 supera los 32 bits.' }
      }
      const appId = Number(entry.value.value)
      return { appId, signedAppId: toSignedAppId(appId) }
    }
    return { issue: 'El appid no es un entero VDF.' }
  } catch (error) {
    return { issue: error instanceof Error ? error.message : String(error) }
  }
}

function readTags(object: VdfObject, issues: ShortcutIssue[], containerKey: string): string[] {
  const entry = findVdfEntryCaseInsensitive(object, 'tags')
  if (!entry) return []
  if (entry.value.kind !== 'object') {
    issues.push({ code: 'invalid_tags', key: containerKey, message: 'El campo tags no es un objeto.' })
    return []
  }
  const tags: string[] = []
  for (const tagEntry of entry.value.entries) {
    if (tagEntry.value.kind === 'string') {
      tags.push(tagEntry.value.value)
    } else {
      issues.push({
        code: 'invalid_tag_value',
        key: containerKey,
        message: `La etiqueta ${tagEntry.key} no es una cadena.`
      })
    }
  }
  return tags
}

/** Inspecciona entradas sin modificar el VDF. Las entradas ajenas se conservan. */
export function inspectShortcuts(root: VdfObject): ShortcutInspection {
  const container = getShortcutsContainer(root)
  const records: ShortcutRecord[] = []
  const issues: ShortcutIssue[] = []
  const seenAppIds = new Map<number, string>()
  for (const topEntry of container.entries) {
    if (topEntry.value.kind !== 'object') {
      issues.push({
        code: 'non_object_shortcut',
        key: topEntry.key,
        message: 'Se ignoró un valor que no es un objeto bajo shortcuts.'
      })
      continue
    }
    const appIdResult = getAppIdField(topEntry.value)
    const record: ShortcutRecord = {
      containerKey: topEntry.key,
      entry: topEntry.value,
      ...(appIdResult.appId !== undefined ? { appId: appIdResult.appId } : {}),
      ...(appIdResult.signedAppId !== undefined ? { signedAppId: appIdResult.signedAppId } : {}),
      appName: getStringField(topEntry.value, 'AppName'),
      exeField: getStringField(topEntry.value, 'Exe'),
      startDirField: getStringField(topEntry.value, 'StartDir'),
      launchOptions: getStringField(topEntry.value, 'LaunchOptions'),
      iconField: getStringField(topEntry.value, 'icon'),
      tags: readTags(topEntry.value, issues, topEntry.key),
      malformed: Boolean(appIdResult.issue)
    }
    if (appIdResult.issue) {
      issues.push({ code: 'invalid_appid', key: topEntry.key, message: appIdResult.issue })
    } else if (record.appId !== undefined) {
      const previous = seenAppIds.get(record.appId)
      if (previous !== undefined) {
        issues.push({
          code: 'duplicate_appid',
          key: topEntry.key,
          message: `El appid ${record.appId} ya aparece en la entrada ${previous}.`
        })
      } else {
        seenAppIds.set(record.appId, topEntry.key)
      }
    }
    records.push(record)
  }
  return { records, issues, container }
}

export interface ShortcutDesired {
  gameId: string
  appName: string
  /** Ruta absoluta del ejecutable, sin comillas. */
  exePath: string
  startDir?: string
  launchOptions?: string
  iconPath?: string
  tags?: string[]
  /** Solo para importaciones explícitas; las referencias gestionadas mandan. */
  appId?: number
}

export interface NormalizedShortcut {
  gameId: string
  appId: number
  appName: string
  exePath: string
  exeField: string
  startDirPath: string
  startDirField: string
  launchOptions: string
  iconPath?: string
  iconField: string
  tags: string[]
}

export interface ManagedShortcutRef {
  gameId: string
  appId: number
}

export type ShortcutAction = 'add' | 'update' | 'unchanged' | 'conflict'

export type ShortcutCollisionKind = 'appId' | 'exe' | 'name'

export interface ShortcutCollision {
  kind: ShortcutCollisionKind
  gameId?: string
  existingKey: string
  existingAppId?: number
  existingAppName?: string
  existingExe?: string
  message: string
}

export type ShortcutAppIdSource =
  | 'managed'
  | 'provided'
  | 'legacy-crc'
  | 'collision-fallback'

export interface ShortcutChange {
  gameId: string
  action: ShortcutAction
  appId: number
  entryKey?: string
  normalized: NormalizedShortcut
  appIdSource: ShortcutAppIdSource
  reason?: string
  collisions: ShortcutCollision[]
}

export interface ShortcutPlan {
  changes: ShortcutChange[]
  collisions: ShortcutCollision[]
  warnings: string[]
  /** Referencias que el coordinador debe persistir para el próximo sync. */
  managedRefs: ManagedShortcutRef[]
  nextIndex: number
}

export interface ShortcutPlanOptions {
  /** merge conserva etiquetas existentes; replace deja solo las deseadas. */
  tagMode?: 'merge' | 'replace'
  allowAppIdFallback?: boolean
}

function validationError(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_ERROR', message, { details })
}

function validateText(value: string, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw validationError(`${label} debe ser texto.`)
  if (/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)) {
    throw validationError(`${label} contiene caracteres de control no permitidos.`)
  }
  const trimmed = value.trim()
  if (!allowEmpty && trimmed.length === 0) throw validationError(`${label} no puede estar vacío.`)
  if (trimmed.length > max) throw validationError(`${label} supera ${max} caracteres.`)
  return trimmed
}

function isAbsoluteAnywhere(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path)
}

function defaultStartDirectory(exePath: string): string {
  return win32.isAbsolute(exePath) ? win32.dirname(exePath) : posix.dirname(exePath)
}

export function normalizeTags(tags: string[] | undefined): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) throw validationError('tags debe ser una lista.')
  if (tags.length > SHORTCUT_TAGS_MAX) {
    throw validationError(`No se permiten más de ${SHORTCUT_TAGS_MAX} etiquetas.`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const tag of tags) {
    const value = validateText(tag, 'Una etiqueta', SHORTCUT_TAG_MAX)
    const key = value.normalize('NFC').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

export function normalizeShortcut(desired: ShortcutDesired, appId: number): NormalizedShortcut {
  const gameId = validateText(desired.gameId, 'gameId', 200)
  const appName = validateText(desired.appName, 'El nombre del acceso', SHORTCUT_NAME_MAX)
  const rawExe = unquoteSteamPath(desired.exePath)
  if (!rawExe || !isAbsoluteAnywhere(rawExe)) {
    throw validationError('Exe debe ser una ruta absoluta.', { exePath: desired.exePath })
  }
  if (/[\u0000\r\n"]/.test(rawExe)) {
    throw validationError('Exe contiene caracteres no válidos para shortcuts.vdf.')
  }
  const startDirRaw = desired.startDir === undefined ? defaultStartDirectory(rawExe) : unquoteSteamPath(desired.startDir)
  if (!startDirRaw || !isAbsoluteAnywhere(startDirRaw)) {
    throw validationError('StartDir debe ser una ruta absoluta.', { startDir: desired.startDir })
  }
  if (/[\u0000\r\n"]/.test(startDirRaw)) {
    throw validationError('StartDir contiene caracteres no válidos para shortcuts.vdf.')
  }
  let launchOptions = ''
  if (desired.launchOptions !== undefined) {
    if (typeof desired.launchOptions !== 'string') {
      throw validationError('LaunchOptions debe ser texto.')
    }
    if (/[\u0000\r\n]/.test(desired.launchOptions)) {
      throw validationError('LaunchOptions contiene NUL o saltos de línea.')
    }
    if (desired.launchOptions.length > SHORTCUT_LAUNCH_OPTIONS_MAX) {
      throw validationError(`LaunchOptions supera ${SHORTCUT_LAUNCH_OPTIONS_MAX} caracteres.`)
    }
    launchOptions = desired.launchOptions
  }
  let iconPath: string | undefined
  let iconField = ''
  if (desired.iconPath !== undefined && desired.iconPath.trim().length > 0) {
    iconPath = unquoteSteamPath(desired.iconPath.trim())
    if (!isAbsoluteAnywhere(iconPath)) {
      throw validationError('El icono debe ser una ruta absoluta.', { iconPath: desired.iconPath })
    }
    if (/[\u0000\r\n"]/.test(iconPath)) {
      throw validationError('La ruta del icono contiene caracteres no válidos.')
    }
    iconField = quoteSteamPath(iconPath)
  }
  return {
    gameId,
    appId: toUnsignedAppId(appId),
    appName,
    exePath: rawExe,
    exeField: quoteSteamPath(rawExe),
    startDirPath: startDirRaw,
    startDirField: quoteSteamPath(startDirRaw),
    launchOptions,
    ...(iconPath ? { iconPath } : {}),
    iconField,
    tags: normalizeTags(desired.tags)
  }
}

function normalizeForNameCompare(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeForExeCompare(value: string): string {
  return unquoteSteamPath(value)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

function mergeTags(existing: string[], desired: string[], mode: 'merge' | 'replace'): string[] {
  if (mode === 'replace') return [...desired]
  const result = [...existing]
  const seen = new Set(existing.map((tag) => tag.normalize('NFC').toLowerCase()))
  for (const tag of desired) {
    const key = tag.normalize('NFC').toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(tag)
    }
  }
  return result
}

function fieldsMatch(record: ShortcutRecord, normalized: NormalizedShortcut): boolean {
  return (
    record.appName === normalized.appName &&
    record.exeField === normalized.exeField &&
    record.startDirField === normalized.startDirField &&
    record.launchOptions === normalized.launchOptions &&
    record.iconField === normalized.iconField &&
    record.tags.length === normalized.tags.length &&
    record.tags.every((tag, index) => tag === normalized.tags[index])
  )
}

function collisionsFor(
  normalized: NormalizedShortcut,
  records: ShortcutRecord[],
  gameId: string,
  targetKey?: string
): ShortcutCollision[] {
  const collisions: ShortcutCollision[] = []
  for (const other of records) {
    if (other.containerKey === targetKey) continue
    if (other.appId === normalized.appId) {
      collisions.push({
        kind: 'appId',
        gameId,
        existingKey: other.containerKey,
        ...(other.appId !== undefined ? { existingAppId: other.appId } : {}),
        ...(other.appName ? { existingAppName: other.appName } : {}),
        ...(other.exeField ? { existingExe: other.exeField } : {}),
        message: `El AppID ${normalized.appId} ya está en uso por la entrada ${other.containerKey}.`
      })
    }
    if (
      other.exeField &&
      normalizeForExeCompare(other.exeField) === normalizeForExeCompare(normalized.exeField)
    ) {
      collisions.push({
        kind: 'exe',
        gameId,
        existingKey: other.containerKey,
        ...(other.appId !== undefined ? { existingAppId: other.appId } : {}),
        ...(other.appName ? { existingAppName: other.appName } : {}),
        ...(other.exeField ? { existingExe: other.exeField } : {}),
        message: `La ruta Exe ya existe en la entrada ajena ${other.containerKey}; no se modifica.`
      })
    }
    if (other.appName && normalizeForNameCompare(other.appName) === normalizeForNameCompare(normalized.appName)) {
      collisions.push({
        kind: 'name',
        gameId,
        existingKey: other.containerKey,
        ...(other.appId !== undefined ? { existingAppId: other.appId } : {}),
        ...(other.appName ? { existingAppName: other.appName } : {}),
        ...(other.exeField ? { existingExe: other.exeField } : {}),
        message: `El nombre ya existe en la entrada ajena ${other.containerKey}; no se modifica.`
      })
    }
  }
  return collisions
}

function chooseEntryKey(container: VdfObject): { key: string; nextIndex: number } {
  let max = -1
  const used = new Set(container.entries.map((entry) => entry.key))
  for (const entry of container.entries) {
    if (/^\d+$/.test(entry.key)) {
      const numeric = Number.parseInt(entry.key, 10)
      if (Number.isSafeInteger(numeric) && numeric > max) max = numeric
    }
  }
  let next = max + 1
  while (used.has(String(next))) next += 1
  return { key: String(next), nextIndex: next + 1 }
}

function validateManagedRefs(refs: ManagedShortcutRef[]): ManagedShortcutRef[] {
  const gameIds = new Set<string>()
  const appIds = new Set<number>()
  return refs.map((ref) => {
    const gameId = validateText(ref.gameId, 'gameId de referencia', 200)
    const appId = toUnsignedAppId(ref.appId)
    if (appId === 0) throw validationError(`La referencia gestionada ${gameId} tiene AppID 0.`)
    if (gameIds.has(gameId)) throw validationError(`Referencia gestionada duplicada: ${gameId}`)
    if (appIds.has(appId)) throw validationError(`Dos juegos comparten el AppID gestionado ${appId}`)
    gameIds.add(gameId)
    appIds.add(appId)
    return { gameId, appId }
  })
}

/**
 * Planifica solo entradas gestionadas. Nunca adopta una entrada ajena por
 * nombre o ruta: la identidad de lo gestionado es exclusivamente la referencia
 * persistida gameId -> appid.
 */
export function planShortcutChanges(
  existing: VdfObject | ShortcutInspection,
  desired: ShortcutDesired[],
  managedRefs: ManagedShortcutRef[] = [],
  options: ShortcutPlanOptions = {}
): ShortcutPlan {
  if (!Array.isArray(desired)) throw validationError('desired debe ser una lista.')
  const inspection = 'records' in existing && 'issues' in existing ? existing : inspectShortcuts(existing)
  const refs = validateManagedRefs(managedRefs)
  const refByGame = new Map(refs.map((ref) => [ref.gameId, ref]))
  const recordsByAppId = new Map<number, ShortcutRecord[]>()
  for (const record of inspection.records) {
    if (record.appId === undefined) continue
    const list = recordsByAppId.get(record.appId) ?? []
    list.push(record)
    recordsByAppId.set(record.appId, list)
  }
  const occupied = new Set<number>()
  for (const record of inspection.records) {
    if (record.appId !== undefined) occupied.add(record.appId)
  }
  for (const ref of refs) occupied.add(ref.appId)

  let next = chooseEntryKey(inspection.container)
  const changes: ShortcutChange[] = []
  const collisions: ShortcutCollision[] = []
  const warnings: string[] = []
  const successfulRefs: ManagedShortcutRef[] = []
  const desiredGameIds = new Set<string>()
  const desiredAppIds = new Map<number, string>()
  const desiredNames = new Map<string, string>()
  const desiredExes = new Map<string, string>()
  const tagMode = options.tagMode ?? 'merge'
  const allowFallback = options.allowAppIdFallback ?? true

  for (const item of desired) {
    const gameId = validateText(item.gameId, 'gameId', 200)
    if (desiredGameIds.has(gameId)) {
      throw validationError(`Hay dos juegos con el mismo gameId: ${gameId}`)
    }
    desiredGameIds.add(gameId)
    const ref = refByGame.get(gameId)
    const matches = ref ? (recordsByAppId.get(ref.appId) ?? []) : []
    const record = matches.length === 1 ? matches[0] : undefined
    if (ref && matches.length > 1) {
      const normalized = normalizeShortcut(item, ref.appId)
      const collision: ShortcutCollision = {
        kind: 'appId',
        gameId,
        existingKey: matches.map((match) => match.containerKey).join(','),
        existingAppId: ref.appId,
        message: `El AppID gestionado ${ref.appId} aparece en varias entradas; no se elige una en silencio.`
      }
      changes.push({
        gameId,
        action: 'conflict',
        appId: ref.appId,
        normalized,
        appIdSource: 'managed',
        reason: collision.message,
        collisions: [collision]
      })
      collisions.push(collision)
      continue
    }

    let appId: number
    let appIdSource: ShortcutAppIdSource
    if (ref) {
      appId = ref.appId
      appIdSource = 'managed'
    } else if (item.appId !== undefined) {
      appId = toUnsignedAppId(item.appId)
      if (appId === 0) {
        throw validationError(`El AppID explícito de ${gameId} no puede ser 0.`)
      }
      appIdSource = 'provided'
      occupied.add(appId)
    } else {
      const allocation = allocateShortcutAppId(item.exePath, item.appName, occupied, { salt: gameId })
      appId = allocation.appId
      appIdSource = allocation.source
      if (allocation.source === 'collision-fallback') {
        warnings.push(
          `El AppID heredado de ${gameId} colisionaba; se usó un AppID de respaldo determinista ${appId}.`
        )
      }
      if (!allowFallback && allocation.source === 'collision-fallback') {
        const normalized = normalizeShortcut(item, appId)
        changes.push({
          gameId,
          action: 'conflict',
          appId,
          normalized,
          appIdSource,
          reason: 'El AppID heredado colisiona y el respaldo está desactivado.',
          collisions: []
        })
        continue
      }
      occupied.add(appId)
    }

    if (!ref && item.appId !== undefined) {
      const otherRef = refs.find((candidate) => candidate.gameId !== gameId && candidate.appId === appId)
      if (otherRef) {
        const collision: ShortcutCollision = {
          kind: 'appId',
          gameId,
          existingKey: otherRef.gameId,
          existingAppId: appId,
          message: `El AppID ${appId} ya está reservado por la referencia gestionada de ${otherRef.gameId}.`
        }
        changes.push({
          gameId,
          action: 'conflict',
          appId,
          normalized: normalizeShortcut(item, appId),
          appIdSource,
          reason: collision.message,
          collisions: [collision]
        })
        collisions.push(collision)
        continue
      }
    }

    const normalizedBase = normalizeShortcut(item, appId)
    const normalized: NormalizedShortcut =
      record && tagMode === 'merge'
        ? { ...normalizedBase, tags: mergeTags(record.tags, normalizedBase.tags, tagMode) }
        : normalizedBase

    if (desiredAppIds.has(appId)) {
      const otherGame = desiredAppIds.get(appId) ?? ''
      const collision: ShortcutCollision = {
        kind: 'appId',
        gameId,
        existingKey: otherGame,
        existingAppId: appId,
        message: `Dos juegos del mismo lote comparten el AppID ${appId}.`
      }
      changes.push({
        gameId,
        action: 'conflict',
        appId,
        normalized,
        appIdSource,
        reason: collision.message,
        collisions: [collision]
      })
      collisions.push(collision)
      continue
    }
    const nameKey = normalizeForNameCompare(normalized.appName)
    const exeKey = normalizeForExeCompare(normalized.exeField)
    if (desiredNames.has(nameKey) || desiredExes.has(exeKey)) {
      const reason = desiredNames.has(nameKey)
        ? `Dos juegos del lote comparten el nombre ${normalized.appName}.`
        : 'Dos juegos del lote comparten la ruta Exe.'
      const collision: ShortcutCollision = {
        kind: desiredNames.has(nameKey) ? 'name' : 'exe',
        gameId,
        existingKey: desiredNames.get(nameKey) ?? desiredExes.get(exeKey) ?? '',
        message: reason
      }
      changes.push({
        gameId,
        action: 'conflict',
        appId,
        normalized,
        appIdSource,
        reason,
        collisions: [collision]
      })
      collisions.push(collision)
      continue
    }
    desiredAppIds.set(appId, gameId)
    desiredNames.set(nameKey, gameId)
    desiredExes.set(exeKey, gameId)

    const recordCollisions = collisionsFor(normalized, inspection.records, gameId, record?.containerKey)
    let action: ShortcutAction
    let reason: string | undefined
    if (!record) {
      action = 'add'
      if (recordCollisions.length > 0) {
        action = 'conflict'
        reason = 'Existe una entrada ajena con el mismo AppID, nombre o ruta; no se duplica.'
      }
    } else if (fieldsMatch(record, normalized)) {
      action = 'unchanged'
    } else {
      action = 'update'
      if (recordCollisions.length > 0) {
        action = 'conflict'
        reason = 'La actualización chocaría con una entrada ajena; no se modifica.'
      }
    }

    let entryKey = record?.containerKey
    if (action === 'add' && entryKey === undefined) {
      entryKey = next.key
      next = { key: String(next.nextIndex), nextIndex: next.nextIndex + 1 }
    }

    changes.push({
      gameId,
      action,
      appId,
      ...(entryKey ? { entryKey } : {}),
      normalized,
      appIdSource,
      ...(reason ? { reason } : {}),
      collisions: recordCollisions
    })
    collisions.push(...recordCollisions)
    if (action !== 'conflict') successfulRefs.push({ gameId, appId })
  }

  return {
    changes,
    collisions,
    warnings,
    managedRefs: successfulRefs,
    nextIndex: next.nextIndex
  }
}

function tagsObject(tags: string[]): VdfObject {
  return createVdfObject(
    tags.map((tag, index) => createVdfEntry(String(index), createVdfString(tag)))
  )
}

function buildNewShortcutEntry(normalized: NormalizedShortcut): VdfObject {
  return createVdfObject([
    createVdfEntry('appid', createVdfInt32(toSignedAppId(normalized.appId))),
    createVdfEntry('AppName', createVdfString(normalized.appName)),
    createVdfEntry('Exe', createVdfString(normalized.exeField)),
    createVdfEntry('StartDir', createVdfString(normalized.startDirField)),
    createVdfEntry('icon', createVdfString(normalized.iconField)),
    createVdfEntry('ShortcutPath', createVdfString('')),
    createVdfEntry('LaunchOptions', createVdfString(normalized.launchOptions)),
    createVdfEntry('IsHidden', createVdfInt32(0)),
    createVdfEntry('AllowDesktopConfig', createVdfInt32(1)),
    createVdfEntry('AllowOverlay', createVdfInt32(1)),
    createVdfEntry('LastPlayTime', createVdfInt32(0)),
    createVdfEntry('tags', tagsObject(normalized.tags))
  ])
}

function upsertFieldCaseInsensitive(object: VdfObject, key: string, value: VdfValue): VdfObject {
  const entries: VdfEntry[] = []
  let replaced = false
  for (const entry of object.entries) {
    if (!replaced && entry.key.toLowerCase() === key.toLowerCase()) {
      entries.push({ key: entry.key, ...(entry.keyRaw ? { keyRaw: entry.keyRaw } : {}), value })
      replaced = true
    } else {
      entries.push(entry)
    }
  }
  if (!replaced) entries.push({ key, value })
  return createVdfObject(entries)
}

function updateShortcutEntry(existing: VdfObject, normalized: NormalizedShortcut): VdfObject {
  let updated = existing
  updated = upsertFieldCaseInsensitive(updated, 'AppName', createVdfString(normalized.appName))
  updated = upsertFieldCaseInsensitive(updated, 'Exe', createVdfString(normalized.exeField))
  updated = upsertFieldCaseInsensitive(updated, 'StartDir', createVdfString(normalized.startDirField))
  updated = upsertFieldCaseInsensitive(updated, 'icon', createVdfString(normalized.iconField))
  updated = upsertFieldCaseInsensitive(updated, 'LaunchOptions', createVdfString(normalized.launchOptions))
  updated = upsertFieldCaseInsensitive(updated, 'tags', tagsObject(normalized.tags))
  return updated
}

function replaceShortcutsContainer(root: VdfObject, container: VdfObject): VdfObject {
  const entries: VdfEntry[] = []
  let replaced = false
  for (const entry of root.entries) {
    if (!replaced && entry.key.toLowerCase() === 'shortcuts') {
      entries.push({ key: entry.key, ...(entry.keyRaw ? { keyRaw: entry.keyRaw } : {}), value: container })
      replaced = true
    } else {
      entries.push(entry)
    }
  }
  if (!replaced) entries.push(createVdfEntry('shortcuts', container))
  return createVdfObject(entries)
}

export interface ApplyShortcutPlanResult {
  root: VdfObject
  applied: ShortcutChange[]
}

/**
 * Aplica a un documento nuevo solo las operaciones add/update del plan. Las
 * entradas ajenas y los campos no gestionados se reutilizan sin cambios. Si el
 * plan contiene conflictos, aborta por defecto para no duplicar nada.
 */
export function applyShortcutPlan(
  root: VdfObject,
  plan: ShortcutPlan,
  options: { allowConflicts?: boolean } = {}
): ApplyShortcutPlanResult {
  const conflicts = plan.changes.filter((change) => change.action === 'conflict')
  if (conflicts.length > 0 && !options.allowConflicts) {
    throw new AppError('STEAM_SYNC_FAILED', 'El plan contiene conflictos; no se aplicó ningún cambio.', {
      details: {
        conflicts: conflicts.map((change) => ({
          gameId: change.gameId,
          appId: change.appId,
          reason: change.reason,
          collisions: change.collisions
        }))
      }
    })
  }

  const originalContainer = getShortcutsContainer(root)
  const containerEntries: VdfEntry[] = [...originalContainer.entries]
  const applied: ShortcutChange[] = []
  const usedKeys = new Set(containerEntries.map((entry) => entry.key))

  for (const change of plan.changes) {
    if (change.action === 'conflict' || change.action === 'unchanged') continue
    if (change.action === 'add') {
      const key = change.entryKey ?? (() => {
        let candidate = containerEntries.length
        while (usedKeys.has(String(candidate))) candidate += 1
        return String(candidate)
      })()
      if (usedKeys.has(key)) {
        throw new AppError('STEAM_SYNC_FAILED', `La clave de shortcut ${key} ya existe.`)
      }
      usedKeys.add(key)
      containerEntries.push(createVdfEntry(key, buildNewShortcutEntry(change.normalized)))
      applied.push(change)
      continue
    }

    const index = containerEntries.findIndex((entry) => entry.key === change.entryKey)
    const target = index >= 0 ? containerEntries[index] : undefined
    if (!target || target.value.kind !== 'object') {
      throw new AppError('STEAM_SYNC_FAILED', `No se encontró la entrada gestionada ${change.entryKey}.`)
    }
    const current = inspectShortcuts(
      createVdfObject([createVdfEntry('shortcuts', createVdfObject([target]))])
    ).records[0]
    if (!current || current.appId !== change.appId) {
      throw new AppError(
        'STEAM_SYNC_FAILED',
        `La entrada ${change.entryKey} ya no tiene el AppID gestionado ${change.appId}; no se adopta.`
      )
    }
    containerEntries[index] = {
      key: target.key,
      ...(target.keyRaw ? { keyRaw: target.keyRaw } : {}),
      value: updateShortcutEntry(target.value, change.normalized)
    }
    applied.push(change)
  }

  const newRoot = replaceShortcutsContainer(
    root,
    createVdfObject(containerEntries)
  )
  return { root: newRoot, applied }
}

/** Serializa y valida el documento resultante (incluye roundtrip). */
export function serializePlannedShortcuts(root: VdfObject): Buffer {
  return serializeShortcutsVdf(root)
}

export function findManagedRecord(
  inspection: ShortcutInspection,
  ref: ManagedShortcutRef
): ShortcutRecord | undefined {
  const appId = toUnsignedAppId(ref.appId)
  const matches = inspection.records.filter((record) => record.appId === appId)
  return matches.length === 1 ? matches[0] : undefined
}

export interface RemoveManagedShortcutOptions {
  /** Si se indica, solo se borra cuando el nombre coincide exactamente. */
  expectedAppName?: string
  /** Si se indica, solo se borra cuando el campo Exe coincide exactamente. */
  expectedExeField?: string
}

export interface RemovedManagedShortcut {
  gameId: string
  appId: number
  entryKey: string
}

export interface RemoveManagedShortcutsResult {
  root: VdfObject
  removed: RemovedManagedShortcut[]
  skipped: Array<{ gameId: string; appId: number; reason: string }>
}

/**
 * Retira accesos gestionados por referencia persistida. Solo borra el appid
 * exacto indicado; nunca busca por nombre/ruta. Si el appid es ambiguo o no
 * existe, no se toca nada. Los appids de entradas ajenas no se pasan aquí.
 */
export function removeManagedShortcuts(
  root: VdfObject,
  refs: ManagedShortcutRef[],
  options: RemoveManagedShortcutOptions = {}
): RemoveManagedShortcutsResult {
  const validated = validateManagedRefs(refs)
  const container = getShortcutsContainer(root)
  const toRemove = new Set<string>()
  const removed: RemovedManagedShortcut[] = []
  const skipped: RemoveManagedShortcutsResult['skipped'] = []

  for (const ref of validated) {
    const matches = container.entries.filter(
      (entry) => entry.value.kind === 'object' &&
        getAppIdField(entry.value).appId === ref.appId
    )
    if (matches.length === 0) {
      skipped.push({ gameId: ref.gameId, appId: ref.appId, reason: 'no-existe' })
      continue
    }
    if (matches.length > 1) {
      skipped.push({ gameId: ref.gameId, appId: ref.appId, reason: 'appid-duplicado' })
      continue
    }
    const match = matches[0]
    if (!match || match.value.kind !== 'object') continue
    const appName = getStringField(match.value, 'AppName')
    const exeField = getStringField(match.value, 'Exe')
    if (options.expectedAppName !== undefined && options.expectedAppName !== appName) {
      skipped.push({ gameId: ref.gameId, appId: ref.appId, reason: 'nombre-distinto' })
      continue
    }
    if (options.expectedExeField !== undefined && options.expectedExeField !== exeField) {
      skipped.push({ gameId: ref.gameId, appId: ref.appId, reason: 'exe-distinto' })
      continue
    }
    toRemove.add(match.key)
    removed.push({ gameId: ref.gameId, appId: ref.appId, entryKey: match.key })
  }

  const newContainer = createVdfObject(
    container.entries.filter((entry) => !toRemove.has(entry.key))
  )
  return {
    root: replaceShortcutsContainer(root, newContainer),
    removed,
    skipped
  }
}

export function shortcutAppIdFromFields(exeField: string, appName: string): number {
  return computeShortcutAppIdFromFields(exeField, appName)
}
