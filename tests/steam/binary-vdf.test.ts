import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createEmptyShortcutsRoot,
  createVdfEntry,
  createVdfInt32,
  createVdfObject,
  createVdfString,
  createVdfUint64,
  findVdfEntry,
  getShortcutsContainer,
  getVdfObject,
  getVdfString,
  parseBinaryVdf,
  parseShortcutsVdf,
  serializeBinaryVdf,
  serializeShortcutsVdf,
  vdfObjectsEqual
} from '@core/steam'
import { FIXTURES } from './helpers'

function manualObject(
  entries: Array<{ key: string; type: 'string' | 'int32' | 'uint64'; value: string | number | bigint }>,
  end = true
): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const key = Buffer.from(`${entry.key}\u0000`, 'utf8')
    if (entry.type === 'string') {
      parts.push(Buffer.from([0x01]), key, Buffer.from(`${String(entry.value)}\u0000`, 'utf8'))
    } else if (entry.type === 'int32') {
      const value = Buffer.alloc(4)
      value.writeInt32LE(Number(entry.value), 0)
      parts.push(Buffer.from([0x02]), key, value)
    } else {
      const value = Buffer.alloc(8)
      value.writeBigUInt64LE(BigInt(entry.value), 0)
      parts.push(Buffer.from([0x07]), key, value)
    }
  }
  if (end) parts.push(Buffer.from([0x08]))
  return Buffer.concat(parts)
}

function manualShortcuts(entries: Buffer[], extraRoot: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('shortcuts\u0000', 'utf8'),
    ...entries,
    Buffer.from([0x08]),
    extraRoot,
    Buffer.from([0x08])
  ])
}

describe('VDF binario', () => {
  it('parsea el fixture y lo vuelve a serializar byte a byte', async () => {
    const fixture = await readFile(join(FIXTURES, 'shortcuts.sample.vdf'))
    const root = parseShortcutsVdf(fixture)
    const output = serializeShortcutsVdf(root)
    expect(output.equals(fixture)).toBe(true)
  })

  it('interpreta int32, uint64, objetos anidados y cadenas sin perder bytes', async () => {
    const fixture = await readFile(join(FIXTURES, 'shortcuts.sample.vdf'))
    const root = parseShortcutsVdf(fixture)
    const shortcuts = getShortcutsContainer(root)
    const kodi = getVdfObject(shortcuts, '0')
    expect(kodi).toBeDefined()
    const appid = findVdfEntry(kodi!, 'appid')
    expect(appid?.value).toEqual({ kind: 'int32', value: -1851770838 })
    expect(getVdfString(kodi!, 'AppName')).toBe('Kodi')
    const unknown = getVdfObject(kodi!, 'UnknownObject')
    expect(unknown).toBeDefined()
    const legacy = findVdfEntry(unknown!, 'LegacyText')
    expect(legacy?.value.kind).toBe('string')
    if (legacy?.value.kind === 'string') {
      expect(legacy.value.raw).toEqual(Buffer.from([0xe9]))
      expect(legacy.value.value).toContain('\ufffd')
    }
    const topNumber = findVdfEntry(root, 'topNumber')
    expect(topNumber?.value).toEqual({ kind: 'uint64', value: 0x1122334455667788n })
    expect(getVdfString(root, 'unknownTop')).toBe('top-level')
  })

  it('serializa uint64 y conserva el orden y duplicados de claves', () => {
    const duplicate = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('root\u0000'),
      manualObject([
        { key: 'a', type: 'string', value: 'primero' },
        { key: 'a', type: 'string', value: 'segundo' }
      ]),
      Buffer.from([0x00]),
      Buffer.from('nested\u0000'),
      manualObject([{ key: 'big', type: 'uint64', value: 18446744073709551615n }]),
      Buffer.from([0x08])
    ])
    const root = parseBinaryVdf(duplicate)
    const reparse = parseBinaryVdf(serializeBinaryVdf(root))
    expect(reparse.entries.map((entry) => entry.key)).toEqual(['root', 'nested'])
    const inner = findVdfEntry(root, 'root')
    expect(inner?.value.kind).toBe('object')
    if (inner?.value.kind === 'object') {
      expect(inner.value.entries.map((entry) => entry.key)).toEqual(['a', 'a'])
      expect(inner.value.entries[1]?.value).toMatchObject({ kind: 'string', value: 'segundo' })
    }
    const nested = findVdfEntry(root, 'nested')
    expect(nested?.value.kind).toBe('object')
    if (nested?.value.kind === 'object') {
      expect(nested.value.entries[0]?.value).toEqual({
        kind: 'uint64',
        value: 18446744073709551615n
      })
    }
    expect(serializeBinaryVdf(root).equals(duplicate)).toBe(true)
  })

  it('rechaza tipos desconocidos, truncados, sin fin y con bytes extra', () => {
    const unknownType = Buffer.concat([
      Buffer.from([0x03]),
      Buffer.from('x\u0000'),
      Buffer.from([0, 0, 0, 0, 0x08])
    ])
    expect(() => parseBinaryVdf(unknownType)).toThrowError(/Tipo de VDF no soportado/)

    const missingEnd = Buffer.concat([Buffer.from([0x00]), Buffer.from('shortcuts\u0000')])
    expect(() => parseBinaryVdf(missingEnd)).toThrowError(/fin de objeto/)

    const truncated = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from('x\u0000'),
      Buffer.from([1, 2])
    ])
    expect(() => parseBinaryVdf(truncated)).toThrowError(/truncado/)

    const fixture = manualShortcuts([manualObject([{ key: 'appid', type: 'int32', value: 1 }])])
    expect(() => parseBinaryVdf(Buffer.concat([fixture, Buffer.from([0x00])]))).toThrowError(
      /bytes después/
    )
    expect(() => parseBinaryVdf(Buffer.alloc(0))).toThrowError(/vacío/)
  })

  it('aplica límites de profundidad, entradas y tamaño', async () => {
    const fixture = await readFile(join(FIXTURES, 'shortcuts.sample.vdf'))
    expect(() => parseShortcutsVdf(fixture, { maxDepth: 1 })).toThrowError(/profundidad/)
    expect(() => parseShortcutsVdf(fixture, { maxEntries: 1 })).toThrowError(/entradas/)
    expect(() => parseShortcutsVdf(fixture, { maxBytes: 10 })).toThrowError(/máximo/)
    expect(() => parseShortcutsVdf(fixture, { maxStringBytes: 3 })).toThrowError(/máximo/)
  })

  it('exige el objeto raíz shortcuts', () => {
    const other = serializeBinaryVdf(createVdfObject([createVdfEntry('x', createVdfString('y'))]))
    expect(() => parseShortcutsVdf(other)).toThrowError(/shortcuts/)
    expect(() => serializeShortcutsVdf(createVdfObject([]))).toThrowError(/shortcuts/)
  })

  it('valida rangos y NUL al serializar', () => {
    const root = createEmptyShortcutsRoot()
    const badInt = createVdfObject([
      createVdfEntry('shortcuts', createVdfObject([createVdfEntry('x', createVdfInt32(2 ** 31))]))
    ])
    expect(() => serializeBinaryVdf(badInt)).toThrowError(/fuera de rango/)
    const badString = createVdfObject([
      createVdfEntry('shortcuts', createVdfObject([createVdfEntry('x', createVdfString('a\u0000b'))]))
    ])
    expect(() => serializeBinaryVdf(badString)).toThrowError(/NUL/)
    const badUint = createVdfObject([
      createVdfEntry('shortcuts', createVdfObject([createVdfEntry('x', createVdfUint64(-1n))]))
    ])
    expect(() => serializeBinaryVdf(badUint)).toThrowError(/fuera de rango/)
    expect(serializeBinaryVdf(root).length).toBeGreaterThan(0)
  })

  it('detecta mutaciones de value aunque exista raw y conserva igualdad estructural', async () => {
    const fixture = await readFile(join(FIXTURES, 'shortcuts.sample.vdf'))
    const root = parseShortcutsVdf(fixture)
    const shortcuts = getShortcutsContainer(root)
    const kodi = getVdfObject(shortcuts, '0')
    const nameEntry = findVdfEntry(kodi!, 'AppName')
    expect(nameEntry?.value.kind).toBe('string')
    if (nameEntry?.value.kind === 'string') {
      const mutated = createVdfObject([
        createVdfEntry('shortcuts', createVdfObject([
          createVdfEntry('0', createVdfObject([
            ...kodi!.entries.filter((entry) => entry.key !== 'AppName'),
            createVdfEntry('AppName', createVdfString('Kodi renombrado'))
          ]))
        ]))
      ])
      const output = serializeShortcutsVdf(mutated)
      const reparsed = parseShortcutsVdf(output)
      expect(getVdfString(getVdfObject(getShortcutsContainer(reparsed), '0')!, 'AppName')).toBe(
        'Kodi renombrado'
      )
      expect(vdfObjectsEqual(mutated, reparsed)).toBe(true)
    }
  })
})
