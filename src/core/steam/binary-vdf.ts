import { AppError } from '@shared/errors'

/**
 * Lector/escritor del VDF binario de Valve (KeyValues1 binario). No tiene nada
 * que ver con JSON ni con el VDF de texto.
 *
 * El modelo conserva el orden de las entradas y los bytes originales de claves
 * y cadenas. Así, un parseo seguido de una serialización sin cambios reproduce
 * el archivo byte a byte, incluso si contiene UTF-8 inválido o claves con
 * grafías poco habituales. Las entradas que la aplicación no toca se reutilizan
 * tal cual al construir un documento nuevo.
 *
 * Tipos soportados: 0x00 objeto, 0x01 cadena UTF-8 terminada en NUL,
 * 0x02 int32 little-endian, 0x07 uint64 little-endian y 0x08 fin de objeto.
 * Cualquier otro tipo se rechaza para no inventar una longitud desconocida.
 */

export const VDF_TYPE_OBJECT = 0x00
export const VDF_TYPE_STRING = 0x01
export const VDF_TYPE_INT32 = 0x02
export const VDF_TYPE_UINT64 = 0x07
export const VDF_TYPE_END = 0x08

export const VDF_DEFAULT_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxEntries: 200_000,
  maxStringBytes: 4 * 1024 * 1024
} as const

export interface VdfString {
  readonly kind: 'string'
  readonly value: string
  /** Bytes originales sin el NUL. Solo se conserva si el valor no se modifica. */
  readonly raw?: Buffer
  /** Valor decodificado de `raw`; sirve para detectar mutaciones de `value`. */
  readonly rawDecoded?: string
}

export interface VdfInt32 {
  readonly kind: 'int32'
  readonly value: number
}

export interface VdfUint64 {
  readonly kind: 'uint64'
  readonly value: bigint
}

export type VdfValue = VdfObject | VdfString | VdfInt32 | VdfUint64

export interface VdfEntry {
  readonly key: string
  /** Bytes originales de la clave sin el NUL. */
  readonly keyRaw?: Buffer
  readonly value: VdfValue
}

export interface VdfObject {
  readonly kind: 'object'
  readonly entries: VdfEntry[]
}

export interface VdfLimits {
  maxBytes?: number
  maxDepth?: number
  maxEntries?: number
  maxStringBytes?: number
}

export interface VdfParseOptions extends VdfLimits {}
export interface VdfSerializeOptions extends VdfLimits {}

interface ParseContext {
  buffer: Buffer
  offset: number
  entries: number
  limits: Required<VdfLimits>
}

interface SerializeContext {
  chunks: Buffer[]
  bytes: number
  entries: number
  limits: Required<VdfLimits>
}

function resolveLimits(limits: VdfLimits | undefined): Required<VdfLimits> {
  return {
    maxBytes: limits?.maxBytes ?? VDF_DEFAULT_LIMITS.maxBytes,
    maxDepth: limits?.maxDepth ?? VDF_DEFAULT_LIMITS.maxDepth,
    maxEntries: limits?.maxEntries ?? VDF_DEFAULT_LIMITS.maxEntries,
    maxStringBytes: limits?.maxStringBytes ?? VDF_DEFAULT_LIMITS.maxStringBytes
  }
}

function invalid(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('STEAM_VDF_INVALID', message, { details })
}

function readCStringBytes(context: ParseContext, label: string): Buffer {
  const end = context.buffer.indexOf(0, context.offset)
  if (end < 0) {
    throw invalid(`El VDF termina antes de cerrar ${label}.`, { offset: context.offset })
  }
  const length = end - context.offset
  if (length > context.limits.maxStringBytes) {
    throw invalid(`${label} supera el máximo de ${context.limits.maxStringBytes} bytes.`, {
      offset: context.offset,
      length
    })
  }
  const bytes = Buffer.from(context.buffer.subarray(context.offset, end))
  context.offset = end + 1
  return bytes
}

function readObject(context: ParseContext, depth: number): VdfObject {
  if (depth > context.limits.maxDepth) {
    throw invalid(`El VDF supera la profundidad máxima de ${context.limits.maxDepth}.`, {
      offset: context.offset
    })
  }
  const entries: VdfEntry[] = []
  while (true) {
    if (context.offset >= context.buffer.length) {
      throw invalid('El VDF termina sin el byte 0x08 de fin de objeto.', {
        offset: context.offset
      })
    }
    const type = context.buffer[context.offset]
    context.offset += 1
    if (type === VDF_TYPE_END) return { kind: 'object', entries }
    if (type === undefined) throw invalid('Tipo de VDF ausente.', { offset: context.offset - 1 })

    const keyRaw = readCStringBytes(context, 'una clave')
    const key = keyRaw.toString('utf8')
    if (key.length === 0) {
      throw invalid('El VDF contiene una clave vacía.', { offset: context.offset })
    }

    let value: VdfValue
    switch (type) {
      case VDF_TYPE_OBJECT: {
        value = readObject(context, depth + 1)
        break
      }
      case VDF_TYPE_STRING: {
        const raw = readCStringBytes(context, `la cadena "${key}"`)
        const decoded = raw.toString('utf8')
        value = { kind: 'string', value: decoded, raw, rawDecoded: decoded }
        break
      }
      case VDF_TYPE_INT32: {
        if (context.offset + 4 > context.buffer.length) {
          throw invalid(`El int32 "${key}" está truncado.`, { offset: context.offset })
        }
        value = { kind: 'int32', value: context.buffer.readInt32LE(context.offset) }
        context.offset += 4
        break
      }
      case VDF_TYPE_UINT64: {
        if (context.offset + 8 > context.buffer.length) {
          throw invalid(`El uint64 "${key}" está truncado.`, { offset: context.offset })
        }
        value = { kind: 'uint64', value: context.buffer.readBigUInt64LE(context.offset) }
        context.offset += 8
        break
      }
      default: {
        throw invalid(
          `Tipo de VDF no soportado 0x${type.toString(16).padStart(2, '0')} en "${key}".`,
          { offset: context.offset - keyRaw.length - 2, type, key }
        )
      }
    }

    context.entries += 1
    if (context.entries > context.limits.maxEntries) {
      throw invalid(`El VDF supera el máximo de ${context.limits.maxEntries} entradas.`)
    }
    entries.push({ key, keyRaw, value })
  }
}

/** Parsea un documento VDF binario completo. Devuelve el objeto raíz. */
export function parseBinaryVdf(input: Buffer, options: VdfParseOptions = {}): VdfObject {
  if (!Buffer.isBuffer(input)) {
    throw invalid('El VDF debe recibirse como Buffer binario.')
  }
  const limits = resolveLimits(options)
  if (input.length === 0) throw invalid('El VDF está vacío.')
  if (input.length > limits.maxBytes) {
    throw invalid(`El VDF supera el máximo de ${limits.maxBytes} bytes.`, { size: input.length })
  }
  const context: ParseContext = { buffer: input, offset: 0, entries: 0, limits }
  const root = readObject(context, 0)
  if (context.offset !== input.length) {
    throw invalid('El VDF contiene bytes después del fin del objeto raíz.', {
      offset: context.offset,
      trailingBytes: input.length - context.offset
    })
  }
  return root
}

function ensureEncoding(value: string, label: string, maxStringBytes: number): Buffer {
  if (value.includes('\u0000')) {
    throw invalid(`${label} no puede contener NUL.`)
  }
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > maxStringBytes) {
    throw invalid(`${label} supera el máximo de ${maxStringBytes} bytes.`, {
      length: bytes.length
    })
  }
  return bytes
}

function writeCString(context: SerializeContext, bytes: Buffer): void {
  if (bytes.includes(0)) {
    throw invalid('Una cadena VDF no puede contener NUL.')
  }
  context.chunks.push(bytes, Buffer.from([0]))
  context.bytes += bytes.length + 1
}

function writeObject(context: SerializeContext, object: VdfObject, depth: number): void {
  if (depth > context.limits.maxDepth) {
    throw invalid(`El VDF supera la profundidad máxima de ${context.limits.maxDepth}.`)
  }
  if (object.kind !== 'object') {
    throw invalid('Se esperaba un objeto VDF.')
  }
  for (const entry of object.entries) {
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      throw invalid('Una entrada VDF tiene una clave vacía o inválida.')
    }
    const keyBytes =
      entry.keyRaw && entry.keyRaw.toString('utf8') === entry.key
        ? entry.keyRaw
        : ensureEncoding(entry.key, `La clave "${entry.key}"`, context.limits.maxStringBytes)
    const value = entry.value
    if (value.kind === 'object') {
      context.chunks.push(Buffer.from([VDF_TYPE_OBJECT]))
      context.bytes += 1
      writeCString(context, keyBytes)
      writeObject(context, value, depth + 1)
    } else if (value.kind === 'string') {
      context.chunks.push(Buffer.from([VDF_TYPE_STRING]))
      context.bytes += 1
      writeCString(context, keyBytes)
      const stringBytes =
        value.raw && value.rawDecoded === value.value
          ? value.raw
          : ensureEncoding(value.value, `La cadena "${entry.key}"`, context.limits.maxStringBytes)
      writeCString(context, stringBytes)
    } else if (value.kind === 'int32') {
      if (!Number.isInteger(value.value) || value.value < -2_147_483_648 || value.value > 2_147_483_647) {
        throw invalid(`El int32 "${entry.key}" está fuera de rango.`, { value: value.value })
      }
      context.chunks.push(Buffer.from([VDF_TYPE_INT32]))
      context.bytes += 1
      writeCString(context, keyBytes)
      const number = Buffer.allocUnsafe(4)
      number.writeInt32LE(value.value, 0)
      context.chunks.push(number)
      context.bytes += 4
    } else if (value.kind === 'uint64') {
      if (typeof value.value !== 'bigint' || value.value < 0n || value.value > 18_446_744_073_709_551_615n) {
        throw invalid(`El uint64 "${entry.key}" está fuera de rango.`, {
          value: value.value.toString()
        })
      }
      context.chunks.push(Buffer.from([VDF_TYPE_UINT64]))
      context.bytes += 1
      writeCString(context, keyBytes)
      const number = Buffer.allocUnsafe(8)
      number.writeBigUInt64LE(value.value, 0)
      context.chunks.push(number)
      context.bytes += 8
    } else {
      throw invalid(`Tipo de valor VDF desconocido en "${entry.key}".`)
    }

    context.entries += 1
    if (context.entries > context.limits.maxEntries) {
      throw invalid(`El VDF supera el máximo de ${context.limits.maxEntries} entradas.`)
    }
    if (context.bytes > context.limits.maxBytes) {
      throw invalid(`El VDF serializado supera el máximo de ${context.limits.maxBytes} bytes.`)
    }
  }
  context.chunks.push(Buffer.from([VDF_TYPE_END]))
  context.bytes += 1
}

/** Serializa un objeto raíz a VDF binario de forma determinista. */
export function serializeBinaryVdf(root: VdfObject, options: VdfSerializeOptions = {}): Buffer {
  const context: SerializeContext = {
    chunks: [],
    bytes: 0,
    entries: 0,
    limits: resolveLimits(options)
  }
  writeObject(context, root, 0)
  const output = Buffer.concat(context.chunks, context.bytes)
  if (output.length > context.limits.maxBytes) {
    throw invalid(`El VDF serializado supera el máximo de ${context.limits.maxBytes} bytes.`)
  }
  return output
}

export function createVdfObject(entries: VdfEntry[] = []): VdfObject {
  return { kind: 'object', entries }
}

export function createVdfEntry(key: string, value: VdfValue, keyRaw?: Buffer): VdfEntry {
  return keyRaw ? { key, keyRaw, value } : { key, value }
}

export function createVdfString(value: string): VdfString {
  return { kind: 'string', value }
}

export function createVdfInt32(value: number): VdfInt32 {
  return { kind: 'int32', value }
}

export function createVdfUint64(value: bigint): VdfUint64 {
  return { kind: 'uint64', value }
}

/** Busca la última entrada con esa clave, que es la que gana en un mapa VDF. */
export function findVdfEntry(object: VdfObject, key: string): VdfEntry | undefined {
  for (let index = object.entries.length - 1; index >= 0; index -= 1) {
    const entry = object.entries[index]
    if (entry && entry.key === key) return entry
  }
  return undefined
}

/** Variante tolerante para grafías como AppName/appname u OpenVR/openvr. */
export function findVdfEntryCaseInsensitive(
  object: VdfObject,
  key: string
): VdfEntry | undefined {
  const lower = key.toLowerCase()
  for (let index = object.entries.length - 1; index >= 0; index -= 1) {
    const entry = object.entries[index]
    if (entry && entry.key.toLowerCase() === lower) return entry
  }
  return undefined
}

export function getVdfObject(object: VdfObject, key: string): VdfObject | undefined {
  const entry = findVdfEntry(object, key)
  return entry?.value.kind === 'object' ? entry.value : undefined
}

export function getVdfObjectCaseInsensitive(
  object: VdfObject,
  key: string
): VdfObject | undefined {
  const entry = findVdfEntryCaseInsensitive(object, key)
  return entry?.value.kind === 'object' ? entry.value : undefined
}

export function getVdfString(object: VdfObject, key: string): string | undefined {
  const entry = findVdfEntry(object, key)
  return entry?.value.kind === 'string' ? entry.value.value : undefined
}

export function getVdfInt32(object: VdfObject, key: string): number | undefined {
  const entry = findVdfEntry(object, key)
  return entry?.value.kind === 'int32' ? entry.value.value : undefined
}

export function getVdfUint64(object: VdfObject, key: string): bigint | undefined {
  const entry = findVdfEntry(object, key)
  return entry?.value.kind === 'uint64' ? entry.value.value : undefined
}

/**
 * Devuelve un objeto nuevo con la entrada reemplazada en su posición original
 * o añadida al final. No muta el original.
 */
export function upsertVdfEntry(object: VdfObject, key: string, value: VdfValue): VdfObject {
  const entries = [...object.entries]
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && entry.key === key) {
      entries[index] = { key: entry.key, keyRaw: entry.keyRaw, value }
      return { kind: 'object', entries }
    }
  }
  entries.push({ key, value })
  return { kind: 'object', entries }
}

export function removeVdfEntry(object: VdfObject, key: string): VdfObject {
  return { kind: 'object', entries: object.entries.filter((entry) => entry.key !== key) }
}

export function upsertVdfString(object: VdfObject, key: string, value: string): VdfObject {
  return upsertVdfEntry(object, key, createVdfString(value))
}

export function upsertVdfInt32(object: VdfObject, key: string, value: number): VdfObject {
  return upsertVdfEntry(object, key, createVdfInt32(value))
}

export function cloneVdfValue(value: VdfValue): VdfValue {
  if (value.kind === 'object') {
    return {
      kind: 'object',
      entries: value.entries.map((entry) => ({
        key: entry.key,
        ...(entry.keyRaw ? { keyRaw: Buffer.from(entry.keyRaw) } : {}),
        value: cloneVdfValue(entry.value)
      }))
    }
  }
  if (value.kind === 'string') {
    return {
      kind: 'string',
      value: value.value,
      ...(value.raw ? { raw: Buffer.from(value.raw) } : {}),
      ...(value.rawDecoded !== undefined ? { rawDecoded: value.rawDecoded } : {})
    }
  }
  return { ...value }
}

export function cloneVdfObject(object: VdfObject): VdfObject {
  return cloneVdfValue(object) as VdfObject
}

/** Igualdad estructural que ignora los bytes originales de cadenas válidas. */
export function vdfValuesEqual(left: VdfValue, right: VdfValue): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'object' && right.kind === 'object') {
    if (left.entries.length !== right.entries.length) return false
    for (let index = 0; index < left.entries.length; index += 1) {
      const leftEntry = left.entries[index]
      const rightEntry = right.entries[index]
      if (!leftEntry || !rightEntry) return false
      if (leftEntry.key !== rightEntry.key) return false
      if (!vdfValuesEqual(leftEntry.value, rightEntry.value)) return false
    }
    return true
  }
  if (left.kind === 'string' && right.kind === 'string') return left.value === right.value
  if (left.kind === 'int32' && right.kind === 'int32') return left.value === right.value
  if (left.kind === 'uint64' && right.kind === 'uint64') return left.value === right.value
  return false
}

export function vdfObjectsEqual(left: VdfObject, right: VdfObject): boolean {
  return vdfValuesEqual(left, right)
}

const SHORTCUTS_KEY = 'shortcuts'

/** El archivo shortcuts.vdf es un objeto raíz con un objeto hijo "shortcuts". */
export function parseShortcutsVdf(input: Buffer, options: VdfParseOptions = {}): VdfObject {
  const root = parseBinaryVdf(input, options)
  const container = getVdfObjectCaseInsensitive(root, SHORTCUTS_KEY)
  if (!container) {
    throw invalid('shortcuts.vdf no contiene un objeto raíz "shortcuts".')
  }
  return root
}

export function createEmptyShortcutsRoot(): VdfObject {
  return createVdfObject([createVdfEntry(SHORTCUTS_KEY, createVdfObject())])
}

export function getShortcutsContainer(root: VdfObject): VdfObject {
  const container = getVdfObjectCaseInsensitive(root, SHORTCUTS_KEY)
  if (!container) {
    throw invalid('El documento no contiene un objeto "shortcuts".')
  }
  return container
}

/**
 * Serializa y vuelve a parsear para garantizar que el documento escrito es
 * exactamente el modelo solicitado. Lanza STEAM_VDF_INVALID si no coincide.
 */
export function serializeShortcutsVdf(
  root: VdfObject,
  options: VdfSerializeOptions = {}
): Buffer {
  getShortcutsContainer(root)
  const output = serializeBinaryVdf(root, options)
  let reparsed: VdfObject
  try {
    reparsed = parseShortcutsVdf(output, options)
  } catch (error) {
    throw invalid('La validación interna del VDF serializado ha fallado.', {
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  if (!vdfObjectsEqual(root, reparsed)) {
    throw invalid('El VDF serializado no reproduce el modelo tras volver a parsearlo.')
  }
  return output
}
